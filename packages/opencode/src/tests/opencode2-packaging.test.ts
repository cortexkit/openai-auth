// The packed package works for a consumer on plain Node: `./server` (the
// OpenCode 2 plugin) and the root (the OpenCode 1 plugin) import from a
// consumer that has only this package installed, with
// `@cortexkit/common-auth` nowhere in reach. Needs the build output
// (`bun run build`), which it packs as it is.

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installPackedPlugin, PACKAGE_NAME } from './fixtures/opencode2-pack'

const { consumer, packageDir } = installPackedPlugin()
afterAll(() => rmSync(dirname(consumer), { recursive: true, force: true }))

const PACKAGE_SPECIFIER =
  /^(?:node:[\w/]+|(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(?:\/[\w./-]+)?)$/i

function node(source: string) {
  return spawnSync('node', ['--input-type=module', '-e', source], {
    cwd: consumer,
    encoding: 'utf8',
    // Plain Node with nothing preloaded and no inherited module paths.
    env: { PATH: process.env.PATH ?? '' },
  })
}

describe('packed package on plain Node', () => {
  test('the consumer has no @cortexkit/common-auth to fall back on', () => {
    expect(
      existsSync(join(consumer, 'node_modules', '@cortexkit', 'common-auth')),
    ).toBe(false)
    const probe = node(
      "import('@cortexkit/common-auth/opencode2').then(() => console.log('found'), () => console.log('absent'))",
    )
    expect(probe.stdout.trim()).toBe('absent')
  })

  test('./server imports and is an OpenCode 2 plugin', () => {
    const result = node(
      `const m = await import('${PACKAGE_NAME}/server'); console.log(JSON.stringify({ id: m.default.id, setup: typeof m.default.setup, factory: typeof m.createOpenAIAuthPlugin }))`,
    )
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      id: 'cortexkit-openai-auth',
      setup: 'function',
      factory: 'function',
    })
  })

  // OpenCode 1 loads a package's `./server` export in preference to its root,
  // so that entry must carry the root's OpenCode 1 plugin unchanged.
  test('./server carries the same OpenCode 1 plugin and id as the root', () => {
    const result = node(
      `const s = await import('${PACKAGE_NAME}/server'); const r = await import('${PACKAGE_NAME}'); console.log(JSON.stringify({ server: typeof s.default.server, same: s.default.server === r.default.server, id: s.default.id === r.default.id }))`,
    )
    expect(result.stderr).toBe('')
    expect(JSON.parse(result.stdout)).toEqual({
      server: 'function',
      same: true,
      id: true,
    })
  })

  test('the root imports and is the OpenCode 1 plugin', () => {
    const result = node(
      `const m = await import('${PACKAGE_NAME}'); console.log(typeof m.default?.server)`,
    )
    expect(result.stderr).toBe('')
    expect(result.stdout.trim()).toBe('function')
  })

  test('the bundles import nothing but Node built-ins and their own chunks', () => {
    const dist = join(packageDir, 'dist')
    const files = [
      ...readdirSync(dist).filter((name) => name.endsWith('.js')),
      ...readdirSync(join(dist, 'v2'))
        .filter((name) => name.endsWith('.js'))
        .map((name) => join('v2', name)),
    ]
    const bare = new Set<string>()
    for (const file of files) {
      const source = readFileSync(join(dist, file), 'utf8')
      for (const match of source.matchAll(
        /(?:from|import)\s*\(?\s*["']([^"'./][^"']*)["']/g,
      )) {
        const specifier = match[1] ?? ''
        // Minified code puts other strings after `from`/`import` too; only
        // what is shaped like a package name is a module specifier.
        if (!PACKAGE_SPECIFIER.test(specifier)) continue
        if (!specifier.startsWith('node:')) bare.add(specifier)
      }
    }
    expect([...bare]).toEqual([])
  })
})
