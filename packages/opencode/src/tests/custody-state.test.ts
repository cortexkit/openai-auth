import { describe, expect, test } from 'bun:test'
import {
  CUSTODY_INERT_REASONS,
  type CustodyInertReason,
  evaluateCustodyStartup,
} from '../core/custody-state.ts'

type Local = 'real' | 'tombstone' | 'empty' | 'gone' | 'slot-absent'
type Vault =
  | 'serves'
  | 'cold'
  | 'needs_reauth'
  | 'identity_mismatch'
  | 'no_handle'

type Expected =
  | { kind: 'LOCAL' }
  | {
      kind: 'VAULT'
      canonicalize?: boolean
      installTombstone?: boolean
    }
  | {
      kind: 'INERT'
      reason: CustodyInertReason
      installTombstone?: boolean
      canonicalize?: boolean
    }
  | { kind: 'NEEDS_LOGIN'; reason?: 'corrupt' }

type LocalCase = {
  name: string
  manifest: 'absent' | 'present' | 'unreadable'
  local: Local
  want: Expected
}

type ClaustrumCase = {
  name: string
  manifest: 'absent' | 'present' | 'unreadable'
  local: Local
  vault: Vault
  fingerprintMatch?: boolean
  want: Expected
  mismatchWant?: Expected
}

const vault = (value: Vault) => () => value

const localCases: LocalCase[] = [
  {
    name: 'local × absent × real',
    manifest: 'absent',
    local: 'real',
    want: { kind: 'LOCAL' },
  },
  {
    name: 'local × absent × tombstone',
    manifest: 'absent',
    local: 'tombstone',
    want: { kind: 'NEEDS_LOGIN' },
  },
  {
    name: 'local × absent × empty',
    manifest: 'absent',
    local: 'empty',
    want: { kind: 'NEEDS_LOGIN' },
  },
  {
    name: 'local × absent × gone',
    manifest: 'absent',
    local: 'gone',
    want: { kind: 'NEEDS_LOGIN', reason: 'corrupt' },
  },
  {
    name: 'local × absent × slot-absent',
    manifest: 'absent',
    local: 'slot-absent',
    want: { kind: 'NEEDS_LOGIN' },
  },
  {
    name: 'local × present × real',
    manifest: 'present',
    local: 'real',
    want: { kind: 'INERT', reason: 'enrolled-under-local' },
  },
  {
    name: 'local × present × tombstone',
    manifest: 'present',
    local: 'tombstone',
    want: { kind: 'INERT', reason: 'mode-mismatch' },
  },
  {
    name: 'local × present × empty',
    manifest: 'present',
    local: 'empty',
    want: { kind: 'INERT', reason: 'mode-mismatch' },
  },
  {
    name: 'local × present × gone',
    manifest: 'present',
    local: 'gone',
    want: { kind: 'INERT', reason: 'corrupt-under-binding' },
  },
  {
    name: 'local × present × slot-absent',
    manifest: 'present',
    local: 'slot-absent',
    want: { kind: 'INERT', reason: 'mode-mismatch' },
  },
  {
    name: 'local × unreadable × real',
    manifest: 'unreadable',
    local: 'real',
    want: { kind: 'INERT', reason: 'manifest-unreadable' },
  },
  {
    name: 'local × unreadable × tombstone',
    manifest: 'unreadable',
    local: 'tombstone',
    want: { kind: 'INERT', reason: 'manifest-unreadable' },
  },
  {
    name: 'local × unreadable × empty',
    manifest: 'unreadable',
    local: 'empty',
    want: { kind: 'INERT', reason: 'manifest-unreadable' },
  },
  {
    name: 'local × unreadable × gone',
    manifest: 'unreadable',
    local: 'gone',
    want: { kind: 'INERT', reason: 'manifest-unreadable' },
  },
  {
    name: 'local × unreadable × slot-absent',
    manifest: 'unreadable',
    local: 'slot-absent',
    want: { kind: 'INERT', reason: 'manifest-unreadable' },
  },
]

const claustrumCases: ClaustrumCase[] = [
  {
    name: 'claustrum × absent × real',
    manifest: 'absent',
    local: 'real',
    vault: 'serves',
    want: { kind: 'INERT', reason: 'unbound-under-claustrum' },
  },
  {
    name: 'claustrum × absent × tombstone',
    manifest: 'absent',
    local: 'tombstone',
    vault: 'serves',
    want: { kind: 'INERT', reason: 'orphan-tombstone' },
  },
  {
    name: 'claustrum × absent × empty',
    manifest: 'absent',
    local: 'empty',
    vault: 'serves',
    want: { kind: 'INERT', reason: 'orphan-tombstone' },
  },
  {
    name: 'claustrum × absent × gone',
    manifest: 'absent',
    local: 'gone',
    vault: 'serves',
    want: { kind: 'INERT', reason: 'unbound-under-claustrum' },
  },
  {
    name: 'claustrum × absent × slot-absent',
    manifest: 'absent',
    local: 'slot-absent',
    vault: 'serves',
    want: { kind: 'INERT', reason: 'unbound-under-claustrum' },
  },
  {
    name: 'claustrum × present × tombstone × serves',
    manifest: 'present',
    local: 'tombstone',
    vault: 'serves',
    want: { kind: 'VAULT' },
  },
  {
    name: 'claustrum × present × tombstone × cold',
    manifest: 'present',
    local: 'tombstone',
    vault: 'cold',
    want: { kind: 'INERT', reason: 'vault-cold' },
  },
  {
    name: 'claustrum × present × tombstone × needs_reauth',
    manifest: 'present',
    local: 'tombstone',
    vault: 'needs_reauth',
    want: { kind: 'INERT', reason: 'vault-reauth' },
  },
  {
    name: 'claustrum × present × tombstone × identity_mismatch',
    manifest: 'present',
    local: 'tombstone',
    vault: 'identity_mismatch',
    want: { kind: 'INERT', reason: 'identity-mismatch' },
  },
  {
    name: 'claustrum × present × tombstone × no_handle',
    manifest: 'present',
    local: 'tombstone',
    vault: 'no_handle',
    want: { kind: 'INERT', reason: 'no-handle' },
  },
  {
    name: 'claustrum × present × empty × serves',
    manifest: 'present',
    local: 'empty',
    vault: 'serves',
    want: { kind: 'VAULT', canonicalize: true },
  },
  {
    name: 'claustrum × present × empty × cold',
    manifest: 'present',
    local: 'empty',
    vault: 'cold',
    want: { kind: 'INERT', reason: 'vault-cold', canonicalize: true },
  },
  {
    name: 'claustrum × present × empty × needs_reauth',
    manifest: 'present',
    local: 'empty',
    vault: 'needs_reauth',
    want: { kind: 'INERT', reason: 'vault-reauth', canonicalize: true },
  },
  {
    name: 'claustrum × present × empty × identity_mismatch',
    manifest: 'present',
    local: 'empty',
    vault: 'identity_mismatch',
    want: { kind: 'INERT', reason: 'identity-mismatch', canonicalize: true },
  },
  {
    name: 'claustrum × present × empty × no_handle',
    manifest: 'present',
    local: 'empty',
    vault: 'no_handle',
    want: { kind: 'INERT', reason: 'no-handle', canonicalize: true },
  },
  {
    name: 'claustrum × present × real × serves(match)',
    manifest: 'present',
    local: 'real',
    vault: 'serves',
    fingerprintMatch: true,
    want: { kind: 'INERT', reason: 'takeover-incomplete' },
    mismatchWant: {
      kind: 'INERT',
      reason: 'new-local-family-under-claustrum',
    },
  },
  {
    name: 'claustrum × present × real × cold',
    manifest: 'present',
    local: 'real',
    vault: 'cold',
    want: { kind: 'INERT', reason: 'takeover-incomplete/vault-unavailable' },
  },
  {
    name: 'claustrum × present × real × needs_reauth',
    manifest: 'present',
    local: 'real',
    vault: 'needs_reauth',
    want: { kind: 'INERT', reason: 'takeover-incomplete/vault-unavailable' },
  },
  {
    name: 'claustrum × present × real × identity_mismatch',
    manifest: 'present',
    local: 'real',
    vault: 'identity_mismatch',
    want: { kind: 'INERT', reason: 'identity-mismatch' },
  },
  {
    name: 'claustrum × present × real × no_handle',
    manifest: 'present',
    local: 'real',
    vault: 'no_handle',
    want: { kind: 'INERT', reason: 'no-handle' },
  },
  {
    name: 'claustrum × present × gone × serves',
    manifest: 'present',
    local: 'gone',
    vault: 'serves',
    want: { kind: 'VAULT', installTombstone: true },
  },
  {
    name: 'claustrum × present × gone × cold',
    manifest: 'present',
    local: 'gone',
    vault: 'cold',
    want: { kind: 'INERT', reason: 'vault-cold', installTombstone: true },
  },
  {
    name: 'claustrum × present × gone × needs_reauth',
    manifest: 'present',
    local: 'gone',
    vault: 'needs_reauth',
    want: { kind: 'INERT', reason: 'vault-reauth', installTombstone: true },
  },
  {
    name: 'claustrum × present × gone × identity_mismatch',
    manifest: 'present',
    local: 'gone',
    vault: 'identity_mismatch',
    want: { kind: 'INERT', reason: 'identity-mismatch' },
  },
  {
    name: 'claustrum × present × gone × no_handle',
    manifest: 'present',
    local: 'gone',
    vault: 'no_handle',
    want: { kind: 'INERT', reason: 'no-handle' },
  },
  {
    name: 'claustrum × present × slot-absent × serves',
    manifest: 'present',
    local: 'slot-absent',
    vault: 'serves',
    want: { kind: 'INERT', reason: 'takeover-incomplete/slot-absent' },
  },
  {
    name: 'claustrum × present × slot-absent × cold',
    manifest: 'present',
    local: 'slot-absent',
    vault: 'cold',
    want: { kind: 'INERT', reason: 'takeover-incomplete/slot-absent' },
  },
  {
    name: 'claustrum × present × slot-absent × needs_reauth',
    manifest: 'present',
    local: 'slot-absent',
    vault: 'needs_reauth',
    want: { kind: 'INERT', reason: 'takeover-incomplete/slot-absent' },
  },
  {
    name: 'claustrum × present × slot-absent × identity_mismatch',
    manifest: 'present',
    local: 'slot-absent',
    vault: 'identity_mismatch',
    want: { kind: 'INERT', reason: 'identity-mismatch' },
  },
  {
    name: 'claustrum × present × slot-absent × no_handle',
    manifest: 'present',
    local: 'slot-absent',
    vault: 'no_handle',
    want: { kind: 'INERT', reason: 'no-handle' },
  },
  {
    name: 'claustrum × unreadable × all-local × all-vault',
    manifest: 'unreadable',
    local: 'real',
    vault: 'serves',
    want: { kind: 'INERT', reason: 'manifest-unreadable' },
  },
]

describe('evaluateCustodyStartup — §16 coordinate table', () => {
  test.each(localCases)('$name', ({ manifest, local, want }) => {
    expect(
      evaluateCustodyStartup({
        mode: 'local',
        manifest,
        local,
        vault: vault('serves'),
      }),
    ).toEqual(want)
  })

  test.each(claustrumCases)('$name', (row) => {
    expect(
      evaluateCustodyStartup({
        mode: 'claustrum',
        manifest: row.manifest,
        local: row.local,
        vault: vault(row.vault),
        fingerprintMatch: row.fingerprintMatch,
      }),
    ).toEqual(row.want)

    if (row.mismatchWant) {
      expect(
        evaluateCustodyStartup({
          mode: 'claustrum',
          manifest: row.manifest,
          local: row.local,
          vault: vault(row.vault),
          fingerprintMatch: false,
        }),
      ).toEqual(row.mismatchWant)
    }
  })
})

describe('evaluateCustodyStartup — §16 invariants', () => {
  test('A: local mode never consults the vault accessor', () => {
    expect(
      evaluateCustodyStartup({
        mode: 'local',
        manifest: 'absent',
        local: 'real',
        vault: () => {
          throw new Error('vault accessor was called')
        },
      }),
    ).toEqual({ kind: 'LOCAL' })
  })

  test('B: unreadable manifest wins before local or vault inspection', () => {
    const failureReasons = [
      'missing',
      'permissions',
      'invalid-json',
      'invalid-shape',
      'wrong-version',
      'wrong-provider',
      'wrong-owner',
    ] as const

    for (const failureReason of failureReasons) {
      expect(
        evaluateCustodyStartup({
          mode: 'claustrum',
          manifest: 'unreadable',
          manifestFailureReason: failureReason,
          local: 'empty',
          vault: () => {
            throw new Error('vault accessor was called')
          },
        }),
      ).toEqual({ kind: 'INERT', reason: 'manifest-unreadable' })
    }
  })

  test('C: absent manifest never consults the vault accessor', () => {
    expect(
      evaluateCustodyStartup({
        mode: 'claustrum',
        manifest: 'absent',
        local: 'tombstone',
        vault: () => {
          throw new Error('vault accessor was called')
        },
      }),
    ).toEqual({ kind: 'INERT', reason: 'orphan-tombstone' })
  })

  test('E: canonical and partial tombstones keep the same verdict kind and reason', () => {
    for (const vaultState of [
      'serves',
      'cold',
      'needs_reauth',
      'identity_mismatch',
      'no_handle',
    ] as const) {
      const canonical = evaluateCustodyStartup({
        mode: 'claustrum',
        manifest: 'present',
        local: 'tombstone',
        vault: vault(vaultState),
      })
      const partial = evaluateCustodyStartup({
        mode: 'claustrum',
        manifest: 'present',
        local: 'empty',
        vault: vault(vaultState),
      })
      expect({
        kind: partial.kind,
        reason: 'reason' in partial ? partial.reason : undefined,
      }).toEqual({
        kind: canonical.kind,
        reason: 'reason' in canonical ? canonical.reason : undefined,
      })
      expect('canonicalize' in partial && partial.canonicalize).toBe(true)
    }
  })

  test('main real material with a present binding and no verified login record is inert', () => {
    expect(
      evaluateCustodyStartup({
        mode: 'local',
        manifest: 'present',
        local: 'real',
        isMain: true,
        verifiedLogin: false,
        vault: vault('serves'),
      }),
    ).toEqual({ kind: 'INERT', reason: 'enrolled-under-local' })
  })

  test('install only applies to fallback gone rows with a present binding', () => {
    for (const row of claustrumCases) {
      const verdict = evaluateCustodyStartup({
        mode: 'claustrum',
        manifest: row.manifest,
        local: row.local,
        vault: vault(row.vault),
        fingerprintMatch: row.fingerprintMatch,
      })
      if (
        row.manifest !== 'present' ||
        row.local !== 'gone' ||
        !['serves', 'cold', 'needs_reauth'].includes(row.vault)
      ) {
        expect(
          'installTombstone' in verdict && verdict.installTombstone,
        ).not.toBe(true)
      }
    }
  })

  test('install appears on VAULT only for present fallback-gone serves', () => {
    for (const row of claustrumCases) {
      const verdict = evaluateCustodyStartup({
        mode: 'claustrum',
        manifest: row.manifest,
        local: row.local,
        vault: vault(row.vault),
        fingerprintMatch: row.fingerprintMatch,
      })
      if (verdict.kind !== 'VAULT') continue
      expect(verdict.installTombstone === true).toBe(
        row.manifest === 'present' &&
          row.local === 'gone' &&
          row.vault === 'serves',
      )
    }
  })

  test('exports the complete v7 inert-reason vocabulary', () => {
    expect(CUSTODY_INERT_REASONS).toEqual([
      'enrolled-under-local',
      'mode-mismatch',
      'corrupt-under-binding',
      'manifest-unreadable',
      'unbound-under-claustrum',
      'orphan-tombstone',
      'vault-cold',
      'vault-reauth',
      'identity-mismatch',
      'no-handle',
      'takeover-incomplete',
      'new-local-family-under-claustrum',
      'takeover-incomplete/vault-unavailable',
      'takeover-incomplete/slot-absent',
    ])
  })
})
