import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { observationFromSnapshot } from '@cortexkit/openai-auth-core/pool-quota'
import { PoolAccountSource } from '../core/pool-account-source'
import { quotaMap, seedPool } from './fixtures/pool-install'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

for (const operation of [
  'recordIdentity',
  'recordQuota',
  'refresh',
  'pull',
] as const) {
  test(`OpenCode deferred ${operation} refuses persistence when enrollment lands at commit`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'opencode-write-authority-'))
    const paths = {
      configPath: join(dir, 'config.json'),
      statePath: join(dir, 'state.json'),
    }
    seedPool({ configFile: paths.configPath, stateFile: paths.statePath }, [
      { id: 'main', quota: quotaMap(10) },
    ])
    if (operation === 'recordIdentity') {
      const config = JSON.parse(readFileSync(paths.configPath, 'utf8'))
      delete config.accounts[0].accountId
      writeFileSync(paths.configPath, JSON.stringify(config))
    }
    let enrolled = false
    let armed = false
    let commits = 0
    const makeSource = () =>
      new PoolAccountSource({
        paths: () => paths,
        vaultAuthority: async () => (enrolled ? 'vault' : 'local'),
        store: {
          onStep: (step) => {
            if (armed && step.startsWith('before-')) {
              commits++
              enrolled = true
            }
          },
        },
        refreshProvider: async () => ({
          access: 'rotated',
          refresh: 'rotated-refresh',
          expires: Date.now() + 86400_000,
        }),
        pullQuota: async () =>
          observationFromSnapshot(
            {
              primary: {
                usedPercent: 63,
                remainingPercent: 37,
                windowMinutes: 300,
                checkedAt: Date.now(),
              },
            },
            Date.now(),
            true,
          ),
      })
    let source = makeSource()
    cleanups.push(async () => {
      source.dispose()
      await source.settled()
      rmSync(dir, { recursive: true, force: true })
    })
    await source.load()
    await source.settled()
    const initial = await source.poolStore().read()
    if (initial.status !== 'ready') throw new Error('pool not ready')
    await source.dispose()
    // Use a fresh writer after draining startup quota so the authority fence
    // is exercised by a later commit, not by an already-closed store.
    source = makeSource()
    const bytes = () =>
      [paths.configPath, paths.statePath].map((path) =>
        readFileSync(path, 'utf8'),
      )
    const before = bytes()
    armed = true
    if (operation === 'refresh')
      await source.refreshDueTokens({
        version: 1,
        accounts: [],
        refresh: { refreshBeforeExpiryMinutes: 2000 },
      })
    else if (operation === 'pull') source.poolStore().requestReading('main')
    else {
      const loaded = await source.poolStore().read()
      if (loaded.status !== 'ready') throw new Error('pool not ready')
      const epoch = loaded.rows[0]?.credentialEpoch
      if (epoch === undefined) throw new Error('missing epoch')
      if (operation === 'recordIdentity')
        await source
          .poolStore()
          .recordIdentity('main', 'identity', { credentialEpoch: epoch })
          .catch(() => {})
      else
        await source
          .poolStore()
          .recordQuota(
            'main',
            { credentialEpoch: epoch, identity: loaded.rows[0]?.identity },
            observationFromSnapshot(
              {
                primary: {
                  usedPercent: 63,
                  windowMinutes: 300,
                  checkedAt: Date.now(),
                },
              },
              Date.now(),
              true,
            ),
          )
          .catch(() => {})
    }
    await source.settled()
    await source.dispose()
    // A refused background flush retries, but must not write after enrollment
    // transfers authority to the vault.
    expect(commits).toBeGreaterThan(0)
    expect(bytes()).toEqual(before)
  })
}
