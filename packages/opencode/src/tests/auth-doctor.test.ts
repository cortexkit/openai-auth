import { describe, expect, test } from 'bun:test'
import {
  type AccountStorage,
  hashRefreshToken,
  type OAuthAccount,
} from '@cortexkit/openai-auth-core/internal'
import { createAuthDoctorReport } from '../auth/doctor'

function account(
  id: string,
  overrides: Partial<OAuthAccount> = {},
): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `access-${id}`,
    refresh: `refresh-${id}`,
    expires: Date.now() + 86_400_000,
    enabled: true,
    ...overrides,
  }
}

function storage(accounts: OAuthAccount[]): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    mainAccountId: 'chatgpt-main',
    accounts,
  }
}

function findingCodes(input: Parameters<typeof createAuthDoctorReport>[0]) {
  return createAuthDoctorReport(input).findings.map((finding) => finding.code)
}

describe('OpenAI auth doctor', () => {
  test('detects a missing OpenCode auth slot', () => {
    expect(
      findingCodes({ auth: undefined, storage: storage([account('main')]) }),
    ).toContain('auth-slot-missing')
  })

  test('detects a non-OAuth OpenCode auth slot', () => {
    expect(
      findingCodes({
        auth: { type: 'api' },
        storage: storage([account('main')]),
      }),
    ).toContain('auth-slot-not-oauth')
  })

  test('detects a main refresh token absent from the account store', () => {
    expect(
      findingCodes({
        auth: { type: 'oauth', refresh: 'not-stored' },
        storage: storage([account('fallback')]),
      }),
    ).toContain('main-refresh-not-in-store')
  })

  test('detects an empty account store', () => {
    expect(
      findingCodes({ auth: { type: 'oauth' }, storage: storage([]) }),
    ).toContain('no-accounts')
  })

  test('detects a store with no enabled accounts', () => {
    expect(
      findingCodes({
        auth: { type: 'oauth', refresh: 'refresh-disabled' },
        storage: storage([account('disabled', { enabled: false })]),
      }),
    ).toContain('no-enabled-accounts')
  })

  test('detects an armed non-transient refresh backoff', () => {
    const now = 1_000_000
    expect(
      findingCodes({
        auth: { type: 'oauth', refresh: 'refresh-backed-off' },
        storage: storage([
          account('backed-off', {
            lastRefreshError: {
              message: 'Token refresh failed: 401',
              checkedAt: now,
              nextRetryAt: now + 24 * 60 * 60_000,
              tokenHash: hashRefreshToken('refresh-backed-off'),
            },
          }),
        ]),
        now,
      }),
    ).toContain('armed-non-transient-refresh-backoff')
  })

  test('detects state ids absent from the config roster', () => {
    expect(
      findingCodes({
        auth: { type: 'oauth', refresh: 'refresh-main' },
        storage: storage([account('main')]),
        orphanStateIds: ['orphan-a', 'orphan-b'],
      }),
    ).toContain('orphan-state-ids')
  })

  test('declares one repair for each repairable fault', () => {
    const now = 2_000_000
    const report = createAuthDoctorReport({
      auth: undefined,
      storage: storage([
        account('main', {
          accountId: 'chatgpt-main',
          lastRefreshError: {
            message: 'Token refresh failed: 401',
            checkedAt: now,
            nextRetryAt: now + 24 * 60 * 60_000,
            tokenHash: hashRefreshToken('refresh-main'),
          },
        }),
      ]),
      orphanStateIds: ['orphan'],
      now,
    })

    expect(report.repairs).toEqual([
      { type: 'restore-main-credential' },
      { type: 'clear-refresh-backoff', accountId: 'main' },
      { type: 'prune-orphan-state-ids', ids: ['orphan'] },
    ])
  })
})
