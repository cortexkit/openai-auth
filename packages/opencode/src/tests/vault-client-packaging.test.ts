import { afterEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = join(import.meta.dir, '../../../..')
const script = join(root, 'scripts/check-private-files-tree.mjs')
const temporary: string[] = []
afterEach(() => {
  for (const dir of temporary.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function install(dir: string, name: string, version: string): string {
  const path = join(dir, 'node_modules', '@cortexkit', name)
  mkdirSync(path, { recursive: true })
  writeFileSync(
    join(path, 'package.json'),
    JSON.stringify({ name: `@cortexkit/${name}`, version }),
  )
  return path
}

function tree() {
  const dir = mkdtempSync(join(tmpdir(), 'openai-client-tree-'))
  temporary.push(dir)
  install(dir, 'private-files', '0.2.1')
  const client = install(dir, 'subc-client', '0.16.1')
  install(dir, 'common-auth', '0.16.0')
  return { dir, client }
}

function check(dir: string) {
  return spawnSync(
    process.execPath,
    [script, dir, '--require-subc', '--require-common-auth'],
    { encoding: 'utf8' },
  )
}

describe('vault client packaging', () => {
  for (const host of ['opencode', 'pi']) {
    test(`${host} imports vault clients from runtime dependencies`, () => {
      const packageDir = join(root, 'packages', host)
      const manifest = JSON.parse(
        readFileSync(join(packageDir, 'package.json'), 'utf8'),
      )
      expect(manifest.dependencies['@cortexkit/claustrum-client']).toBe(
        '^0.10.0',
      )
      expect(manifest.dependencies['@cortexkit/subc-client']).toBe('^0.16.0')
      const dist = join(packageDir, 'dist')
      const sources = readdirSync(dist, { recursive: true })
        .map(String)
        .filter((file) => file.endsWith('.js'))
        .map((file) => readFileSync(join(dist, file), 'utf8'))
      expect(sources.length).toBeGreaterThan(0)
      expect(
        sources.some((source) =>
          /(?:from|import)\s*\(?\s*["']@cortexkit\/claustrum-client["']/.test(
            source,
          ),
        ),
      ).toBe(true)
      expect(
        sources.some((source) =>
          /(?:from|import)\s*\(?\s*["']@cortexkit\/subc-client["']/.test(
            source,
          ),
        ),
      ).toBe(true)
      // This error belongs to subc-client's route implementation, not its callers.
      for (const source of sources)
        expect(source).not.toContain('route.open returned no route handle')
    })
  }

  test('counts one physical client despite dependency aliases', () => {
    const { dir, client } = tree()
    const aliases = join(dir, 'consumer', 'node_modules', '@cortexkit')
    mkdirSync(aliases, { recursive: true })
    symlinkSync(client, join(aliases, 'subc-client'), 'dir')
    const result = check(dir)
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.stdout).toContain(
      'subc-client tree ok (1 physical copy: 0.16.1)',
    )
    expect(result.stdout).toContain(
      'private-files tree ok (1 physical copy: 0.2.1',
    )
    expect(result.stdout).toContain(
      'common-auth tree ok (1 physical copy: 0.16.0)',
    )
  })

  test('rejects a second common-auth copy at the same version', () => {
    const { dir } = tree()
    install(join(dir, 'consumer'), 'common-auth', '0.16.0')
    const result = check(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Expected exactly one physical @cortexkit/common-auth, found 2',
    )
  })

  test('ignores old versions Bun keeps in its store that nothing links to', () => {
    const { dir } = tree()
    // Bun keeps every version it installed under node_modules/.bun; a long-lived
    // checkout holds old ones that no package reaches.
    install(
      join(dir, 'node_modules', '.bun', '@cortexkit+common-auth@0.15.0'),
      'common-auth',
      '0.15.0',
    )
    const result = check(dir)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(
      'common-auth tree ok (1 physical copy: 0.16.0)',
    )
  })

  test('counts a second copy reached through the Bun store', () => {
    const { dir } = tree()
    const stored = install(
      join(dir, 'node_modules', '.bun', '@cortexkit+common-auth@0.15.0'),
      'common-auth',
      '0.15.0',
    )
    const aliases = join(dir, 'consumer', 'node_modules', '@cortexkit')
    mkdirSync(aliases, { recursive: true })
    symlinkSync(stored, join(aliases, 'common-auth'), 'dir')
    const result = check(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Expected exactly one physical @cortexkit/common-auth, found 2',
    )
  })

  test('rejects a second subc-client copy at the same version', () => {
    const { dir } = tree()
    install(join(dir, 'consumer'), 'subc-client', '0.16.1')
    const result = check(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Expected exactly one physical @cortexkit/subc-client',
    )
  })

  test('rejects a second private-files copy at the same version', () => {
    const { dir } = tree()
    install(join(dir, 'consumer'), 'private-files', '0.2.1')
    const result = check(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Expected exactly one physical @cortexkit/private-files',
    )
  })

  test('rejects a missing subc-client instead of passing an empty census', () => {
    const { dir, client } = tree()
    rmSync(client, { recursive: true })
    const result = check(dir)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(
      'Expected exactly one physical @cortexkit/subc-client',
    )
  })
})
