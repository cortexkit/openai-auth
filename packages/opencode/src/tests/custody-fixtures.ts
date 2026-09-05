/**
 * Shared fixtures for custody tests.
 *
 * The custody test files (`custody.test.ts`, `custody-refresh.test.ts`) need
 * the same factory inputs — sentinel accounts, live accounts, manifest
 * snapshots — and drifted apart as each file grew its own copy. Keeping the
 * factories here ensures both files pin the same tombstone id, expiry math,
 * and owning-provider manifest shape, so any future drift shows up as a
 * single shared-helper edit instead of two divergent copies.
 */

import type { AccountStorage, OAuthAccount } from '../core/accounts.ts'
import { CUSTODY_TOMBSTONE_PREFIX } from '../core/custody.ts'
import {
  type CustodyManifestReadResult,
  manifestRevision,
} from '../core/custody-manifest.ts'
import type {
  ClaustrumMode,
  CustodyTransitionState,
} from '../core/custody-transition.ts'

const CUSTODY_PROVIDER = 'openai'

export const TOMBSTONE_OPENAI = `${CUSTODY_TOMBSTONE_PREFIX}${CUSTODY_PROVIDER}`
export const CUSTODY_FIXTURE_NOW = 4_102_444_800_000

export function makeSentinelAccount(
  overrides: Partial<OAuthAccount> = {},
): OAuthAccount {
  return {
    id: 'custody-1',
    type: 'oauth',
    access: '',
    refresh: TOMBSTONE_OPENAI,
    expires: 0,
    addedAt: 1_000,
    ...overrides,
  }
}

export function liveAccount(
  id: string,
  overrides: Partial<OAuthAccount> = {},
  now = CUSTODY_FIXTURE_NOW,
): OAuthAccount {
  return {
    id,
    type: 'oauth',
    access: `acc-${id}`,
    refresh: `ref-${id}`,
    expires: now + 3_600_000,
    addedAt: 1_000,
    ...overrides,
  }
}

export function liveStorage(
  accounts: OAuthAccount[],
  overrides: Partial<AccountStorage> = {},
): AccountStorage {
  return {
    version: 1,
    main: { type: 'opencode', provider: CUSTODY_PROVIDER },
    accounts,
    ...overrides,
  }
}

export function claustrumConfig(
  options: {
    mode?: ClaustrumMode
    transition?: CustodyTransitionState
    rowHistory?: string[]
  } = {},
): NonNullable<AccountStorage['claustrum']> {
  return {
    mode: options.mode ?? 'claustrum',
    ...(options.transition ? { transition: options.transition } : {}),
    ...(options.rowHistory ? { rowHistory: options.rowHistory } : {}),
  }
}

export function withClaustrumMode(storage: AccountStorage): AccountStorage {
  return {
    ...storage,
    claustrum: claustrumConfig({ mode: 'claustrum' }),
  }
}

export function emptyManifest(): CustodyManifestReadResult {
  const value = { version: 1 as const, providers: [] }
  return {
    ok: true,
    value,
    revision: manifestRevision(JSON.stringify(value)),
  }
}

export const localCustody = { readManifest: async () => emptyManifest() }

export function enrollmentManifest(label: string): CustodyManifestReadResult {
  const suffix =
    label === 'custody-1'
      ? 'a'.repeat(43)
      : Buffer.from(label).toString('base64url').padEnd(43, 'a').slice(0, 43)
  const handle = `ckh_${suffix}`
  const value = {
    version: 1 as const,
    providers: [
      {
        provider: CUSTODY_PROVIDER,
        shape: 'oauth' as const,
        serve: 'openai-auth',
        accounts: [{ label, handle, credential_id: `oauth:openai:${label}` }],
      },
    ],
  }
  return {
    ok: true,
    value,
    revision: manifestRevision(JSON.stringify(value)),
  }
}
