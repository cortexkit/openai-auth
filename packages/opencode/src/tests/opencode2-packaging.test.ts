// The packed package works for a consumer on plain Node: `./server` (the
// OpenCode 2 plugin) and the root (the OpenCode 1 plugin) import from a
// consumer that has only this package installed, with
// `@cortexkit/common-auth` nowhere in reach. Needs the build output
// (`bun run build`), which it packs as it is.

import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { installPackedPlugin, PACKAGE_NAME } from './fixtures/opencode2-pack'

const { consumer } = installPackedPlugin()
afterAll(() => rmSync(dirname(consumer), { recursive: true, force: true }))

function node(source: string) {
  return spawnSync('node', ['--input-type=module', '-e', source], {
    cwd: consumer,
    encoding: 'utf8',
    // Plain Node with nothing preloaded and no inherited module paths.
    env: { PATH: process.env.PATH ?? '' },
  })
}

describe('packed package on plain Node', () => {
  test('npx setup dry run names the fresh profile config folder without writing it', () => {
    const home = join(consumer, 'profile')
    const config = join(home, '.config', 'opencode')
    mkdirSync(config, { recursive: true })
    const result = spawnSync(
      'npx',
      ['--no-install', 'opencode-openai-auth', 'setup', '--dry-run', '--yes'],
      {
        cwd: consumer,
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH ?? '',
          HOME: home,
          npm_config_update_notifier: 'false',
        },
        timeout: 30_000,
      },
    )
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(config)
    expect(result.stdout).toContain(join(config, 'opencode.jsonc'))
    expect(result.stdout).toContain('Dry run: no registrations')
    expect(readdirSync(config)).toEqual([])
    expect(
      existsSync(join(home, '.local', 'share', 'opencode', 'auth.json')),
    ).toBe(false)
  })

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
})
