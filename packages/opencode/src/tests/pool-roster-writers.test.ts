// On a migrated install the account pool's store is the roster's only
// writer, besides the migration module that creates the pool. Every pool
// module goes through the store (`@cortexkit/common-auth/store`); a call to a
// legacy roster writer from one of them would rewrite the roster behind the
// store's back, dropping what the legacy loader does not know.

import { describe, expect, it } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE_DIR = join(import.meta.dir, '..', 'core')

/**
 * The migration module may write the roster: it turns the legacy roster into
 * the account pool.
 */
const ROSTER_WRITER_MODULES = new Set(['pool-migration.ts'])

/**
 * The functions of `@cortexkit/openai-auth-core` that rewrite the account
 * roster from the legacy loader's view of it, bypassing the store's row
 * locks, refusals and per-row pool entries.
 */
const LEGACY_WRITERS = ['mutateAccounts', 'saveAccounts']

/** Source without comments, so prose naming a writer does not count. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

/** Each legacy writer the source imports or refers to. */
function legacyWriterUses(source: string): string[] {
  const body = code(source)
  return LEGACY_WRITERS.filter((name) => new RegExp(`\\b${name}\\b`).test(body))
}

const poolModules = readdirSync(CORE_DIR)
  .filter((file) => /^pool-.*\.ts$/.test(file))
  .filter((file) => !ROSTER_WRITER_MODULES.has(file))
  .sort()

describe('the roster writers of a migrated install', () => {
  it('finds the pool modules it checks', () => {
    expect(poolModules).toContain('pool-accounts.ts')
    expect(poolModules).toContain('pool-account-source.ts')
  })

  it('names a legacy writer however the source uses it, and ignores comments', () => {
    expect(
      legacyWriterUses("import { mutateAccounts as m } from 'x'\nm()"),
    ).toEqual(['mutateAccounts'])
    expect(legacyWriterUses('await saveAccounts(storage, paths)')).toEqual([
      'saveAccounts',
    ])
    expect(
      legacyWriterUses('// mutateAccounts\n/* saveAccounts */\nconst x = 1'),
    ).toEqual([])
    expect(legacyWriterUses('deps.mutateAccountsFn(current)')).toEqual([])
  })

  for (const file of poolModules) {
    it(`${file} writes the roster only through the store`, () => {
      const source = readFileSync(join(CORE_DIR, file), 'utf8')
      expect(legacyWriterUses(source)).toEqual([])
    })
  }
})
