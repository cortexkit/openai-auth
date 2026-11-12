import { afterEach, beforeEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import {
  hashRefreshToken,
  loadAccounts,
  mutateAccounts,
} from '@cortexkit/openai-auth-core/internal'
import { recordSettingsDecision } from '@cortexkit/openai-auth-core/settings-decisions'
import { authDoctorChecks, readStoreIds } from '../auth/doctor.ts'

let root: string
beforeEach(() => {
  const scratch = resolve(import.meta.dir, '../../../../target/scratch')
  mkdirSync(scratch, { recursive: true })
  root = mkdtempSync(join(scratch, 'settings-doctor-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const preferences = {
  routing: { mode: 'ordered', maxSameAccountWait: 0 },
  fallbackOn: [429, 1.5],
  refresh: { enabled: false, refreshBeforeExpiryMinutes: '300' },
  quota: {
    enabled: false,
    checkIntervalMinutes: 0.5,
    refreshEveryNRequests: 7,
    minimumRemaining: { '5h': '20', '1w': null },
    failClosedOnUnknownQuota: 'true',
  },
  dump: true,
  costZeroing: null,
  killswitch: { enabled: 'yes', main: { '5h': '20', '1w': null } },
  logging: { level: 'trace' },
  cachekeep: { enabled: true, subagents: true, startHour: 8, endHour: 20 },
  cacheKeep: { enabled: false, sustain: true },
  dumpDir: 'old-dumps',
  dumpMaxBytes: 123,
  webSockets: true,
  rawWebSocket: true,
  responsesLite: true,
  codexApiEndpoint: 'https://old.example/responses',
}

for (const code of [
  'orphan-state-ids',
  'armed-non-transient-refresh-backoff',
]) {
  test(`Auth doctor ${code} repair preserves raw preferences by config decision`, async () => {
    const now = 10_000
    for (const decision of ['shared', 'separate'] as const) {
      const paths = {
        configPath: join(root, `${decision}-openai-auth.json`),
        statePath: join(root, `${decision}-openai-auth-state.json`),
      }
      writeFileSync(
        paths.configPath,
        JSON.stringify({
          version: 1,
          accounts: [{ id: 'local', type: 'oauth' }],
          ...preferences,
          commonAuthPool: { migrated: false },
          claustrum: { mode: 'retired' },
        }),
      )
      writeFileSync(
        paths.statePath,
        JSON.stringify({
          version: 1,
          accounts: {
            local: {
              refresh: 'refresh-local',
              lastRefreshError: {
                message: 'Token refresh failed: 401',
                checkedAt: now,
                nextRetryAt: now + 86_400_000,
                tokenHash: hashRefreshToken('refresh-local'),
              },
            },
            orphan: { refresh: 'refresh-orphan' },
          },
        }),
      )
      recordSettingsDecision(paths.configPath, decision)
      const writtenPaths: string[] = []
      const checks = authDoctorChecks({
        paths,
        migrated: false,
        readAuth: async () => ({ type: 'oauth', refresh: 'slot-refresh' }),
        loadAccounts: async (pair) => {
          const storage = await loadAccounts(pair)
          if (!storage) return null
          return {
            ...storage,
            routing: { mode: 'sticky-balanced', maxSameAccountWait: 'max' },
            fallbackOn: [401, 403],
            refresh: { enabled: true, refreshBeforeExpiryMinutes: 10 },
            killswitch: { enabled: false },
            logging: { level: 'error' },
          }
        },
        readStoreIds,
        mutateAccounts: async (mutate, pair, options) => {
          writtenPaths.push(pair.configPath)
          return mutateAccounts(mutate, pair, options)
        },
        setMainAuth: async () => {
          throw new Error('unexpected slot repair')
        },
        now: () => now,
      })
      const findings = await checks[0]!.run()
      const repair = findings.find((finding) => finding.code === code)?.repair
      expect(repair).toBeDefined()
      await repair!.apply()
      expect(writtenPaths).toEqual([paths.configPath])
      const config = JSON.parse(readFileSync(paths.configPath, 'utf8'))
      if (decision === 'shared') {
        for (const [key, value] of Object.entries(preferences)) {
          expect(config[key]).toEqual(value)
        }
      } else {
        expect(config.fallbackOn).toEqual([429])
      }
      expect(config).not.toHaveProperty('claustrum')
      expect(config.commonAuthPool).toEqual({ migrated: false })
      const state = JSON.parse(readFileSync(paths.statePath, 'utf8'))
      expect(state.accounts).not.toHaveProperty('orphan')
      if (code === 'armed-non-transient-refresh-backoff') {
        expect(state.accounts.local).not.toHaveProperty('lastRefreshError')
      }
    }
  })
}
