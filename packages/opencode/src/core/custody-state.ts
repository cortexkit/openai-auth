export type CustodyMode = 'local' | 'claustrum'

export type ManifestCustodyState = 'absent' | 'present' | 'unreadable'

export type LocalCustodyState =
  | 'real'
  | 'tombstone'
  | 'empty'
  | 'gone'
  | 'slot-absent'

export type VaultCustodyState =
  | 'serves'
  | 'cold'
  | 'needs_reauth'
  | 'identity_mismatch'
  | 'no_handle'

export const CUSTODY_INERT_REASONS = [
  'needs-login',
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
] as const

export type CustodyInertReason = (typeof CUSTODY_INERT_REASONS)[number]

export type CustodyVerdict =
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

export interface EvaluateCustodyStartupInput {
  mode: CustodyMode
  manifest: ManifestCustodyState
  local: LocalCustodyState
  vault: () => VaultCustodyState
  manifestFailureReason?: string
  fingerprintMatch?: boolean
  verifiedInProcessLogin: boolean
  isMain?: boolean
}

function unreachable(value: never): never {
  return value
}

function withCanonicalization<
  T extends Extract<CustodyVerdict, { kind: 'VAULT' | 'INERT' }>,
>(local: LocalCustodyState, verdict: T): T | (T & { canonicalize: true }) {
  return local === 'empty' ? { ...verdict, canonicalize: true } : verdict
}

function evaluateLocal(local: LocalCustodyState): CustodyVerdict {
  switch (local) {
    case 'real':
      return { kind: 'LOCAL' }
    case 'tombstone':
    case 'empty':
    case 'slot-absent':
      return { kind: 'NEEDS_LOGIN' }
    case 'gone':
      return { kind: 'NEEDS_LOGIN', reason: 'corrupt' }
  }
  return unreachable(local)
}

function evaluateLocalWithBinding(
  local: LocalCustodyState,
  verifiedInProcessLogin: boolean,
): CustodyVerdict {
  switch (local) {
    case 'real':
      return verifiedInProcessLogin
        ? { kind: 'LOCAL' }
        : { kind: 'INERT', reason: 'needs-login' }
    case 'tombstone':
    case 'empty':
    case 'slot-absent':
      return { kind: 'INERT', reason: 'mode-mismatch' }
    case 'gone':
      return { kind: 'INERT', reason: 'corrupt-under-binding' }
  }
  return unreachable(local)
}

function evaluateUnboundClaustrum(local: LocalCustodyState): CustodyVerdict {
  switch (local) {
    case 'tombstone':
    case 'empty':
      return { kind: 'INERT', reason: 'orphan-tombstone' }
    case 'real':
    case 'gone':
    case 'slot-absent':
      return { kind: 'INERT', reason: 'unbound-under-claustrum' }
  }
  return unreachable(local)
}

function evaluateTombstone(
  local: Extract<LocalCustodyState, 'tombstone' | 'empty'>,
  vault: VaultCustodyState,
): CustodyVerdict {
  switch (vault) {
    case 'serves':
      return withCanonicalization(local, { kind: 'VAULT' })
    case 'cold':
      return withCanonicalization(local, {
        kind: 'INERT',
        reason: 'vault-cold',
      })
    case 'needs_reauth':
      return withCanonicalization(local, {
        kind: 'INERT',
        reason: 'vault-reauth',
      })
    case 'identity_mismatch':
      return withCanonicalization(local, {
        kind: 'INERT',
        reason: 'identity-mismatch',
      })
    case 'no_handle':
      return withCanonicalization(local, { kind: 'INERT', reason: 'no-handle' })
  }
  return unreachable(vault)
}

function evaluateReal(
  vault: VaultCustodyState,
  fingerprintMatch: boolean | undefined,
): CustodyVerdict {
  switch (vault) {
    case 'serves':
      return fingerprintMatch === false
        ? { kind: 'INERT', reason: 'new-local-family-under-claustrum' }
        : { kind: 'INERT', reason: 'takeover-incomplete' }
    case 'cold':
    case 'needs_reauth':
      return { kind: 'INERT', reason: 'takeover-incomplete/vault-unavailable' }
    case 'identity_mismatch':
      return { kind: 'INERT', reason: 'identity-mismatch' }
    case 'no_handle':
      return { kind: 'INERT', reason: 'no-handle' }
  }
  return unreachable(vault)
}

function evaluateGone(vault: VaultCustodyState): CustodyVerdict {
  switch (vault) {
    case 'serves':
      return { kind: 'VAULT', installTombstone: true }
    case 'cold':
      return { kind: 'INERT', reason: 'vault-cold', installTombstone: true }
    case 'needs_reauth':
      return { kind: 'INERT', reason: 'vault-reauth', installTombstone: true }
    case 'identity_mismatch':
      return { kind: 'INERT', reason: 'identity-mismatch' }
    case 'no_handle':
      return { kind: 'INERT', reason: 'no-handle' }
  }
  return unreachable(vault)
}

function evaluateSlotAbsent(vault: VaultCustodyState): CustodyVerdict {
  switch (vault) {
    case 'serves':
    case 'cold':
    case 'needs_reauth':
      return { kind: 'INERT', reason: 'takeover-incomplete/slot-absent' }
    case 'identity_mismatch':
      return { kind: 'INERT', reason: 'identity-mismatch' }
    case 'no_handle':
      return { kind: 'INERT', reason: 'no-handle' }
  }
  return unreachable(vault)
}

function evaluatePresentClaustrum(
  local: LocalCustodyState,
  vault: VaultCustodyState,
  fingerprintMatch: boolean | undefined,
): CustodyVerdict {
  switch (local) {
    case 'tombstone':
    case 'empty':
      return evaluateTombstone(local, vault)
    case 'real':
      return evaluateReal(vault, fingerprintMatch)
    case 'gone':
      return evaluateGone(vault)
    case 'slot-absent':
      return evaluateSlotAbsent(vault)
  }
  return unreachable(local)
}

export function evaluateCustodyStartup(
  input: EvaluateCustodyStartupInput,
): CustodyVerdict {
  if (input.manifest === 'unreadable') {
    return { kind: 'INERT', reason: 'manifest-unreadable' }
  }

  switch (input.mode) {
    case 'local':
      return input.manifest === 'present'
        ? evaluateLocalWithBinding(input.local, input.verifiedInProcessLogin)
        : evaluateLocal(input.local)
    case 'claustrum':
      if (input.manifest === 'absent') {
        return evaluateUnboundClaustrum(input.local)
      }
      if (input.manifest === 'present') {
        return evaluatePresentClaustrum(
          input.local,
          input.vault(),
          input.fingerprintMatch,
        )
      }
      return unreachable(input.manifest)
  }
  return unreachable(input.mode)
}
