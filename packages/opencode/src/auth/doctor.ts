import { readFile } from 'node:fs/promises'
import {
  type AccountPaths,
  type AccountStorage,
  isOAuthAccount,
  NON_TRANSIENT_REFRESH_RETRY_DELAY_MS,
  type OAuthAccount,
  readConfigRosterIds,
  refreshBackoffActive,
} from '@cortexkit/openai-auth-core/internal'

export interface AuthDetails {
  type: string
  access?: string
  refresh?: string
  expires?: number
}

export type AuthDoctorFindingCode =
  | 'auth-slot-missing'
  | 'auth-slot-not-oauth'
  | 'main-refresh-not-in-store'
  | 'no-accounts'
  | 'no-enabled-accounts'
  | 'armed-non-transient-refresh-backoff'
  | 'orphan-state-ids'

export type AuthRepair =
  | { type: 'restore-main-credential' }
  | { type: 'prune-orphan-state-ids'; ids: readonly string[] }
  | { type: 'clear-refresh-backoff'; accountId: string }

export interface AuthDoctorFinding {
  code: AuthDoctorFindingCode
  message: string
  accountId?: string
  repair?: AuthRepair
}

export interface AuthDoctorReport {
  findings: AuthDoctorFinding[]
  repairs: AuthRepair[]
}

interface StoreIds {
  rosterIds: readonly string[]
  stateIds: readonly string[]
  orphanStateIds: readonly string[]
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Read roster/state identity without passing through a writer or normalizer. */
export async function readStoreIds(paths: AccountPaths): Promise<StoreIds> {
  const roster = await readConfigRosterIds(paths.configPath)
  let stateIds: string[] = []
  try {
    const parsed = JSON.parse(
      await readFile(paths.statePath, 'utf8'),
    ) as unknown
    if (objectRecord(parsed)) {
      const accounts = parsed.accounts
      if (objectRecord(accounts)) stateIds = Object.keys(accounts)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  const rosterIds = roster ? [...roster] : []
  return {
    rosterIds,
    stateIds,
    orphanStateIds: roster
      ? stateIds.filter((accountId) => !roster.has(accountId))
      : [],
  }
}

export function findStoredMainCredential(
  storage: AccountStorage | null | undefined,
): OAuthAccount | undefined {
  if (!storage) return undefined
  const reserved = storage.accounts.find(
    (account): account is OAuthAccount =>
      account.id === 'main' && isOAuthAccount(account),
  )
  if (reserved) return reserved
  if (!storage.mainAccountId) return undefined
  return storage.accounts.find(
    (account): account is OAuthAccount =>
      isOAuthAccount(account) && account.accountId === storage.mainAccountId,
  )
}

function hasArmedNonTransientBackoff(account: OAuthAccount, now: number) {
  const error = account.lastRefreshError
  return (
    refreshBackoffActive(error, account.refresh, now) &&
    error !== undefined &&
    error.nextRetryAt !== undefined &&
    error.nextRetryAt - error.checkedAt >= NON_TRANSIENT_REFRESH_RETRY_DELAY_MS
  )
}

export function createAuthDoctorReport(input: {
  auth: AuthDetails | null | undefined
  storage: AccountStorage | null | undefined
  orphanStateIds?: readonly string[]
  now?: number
}): AuthDoctorReport {
  const findings: AuthDoctorFinding[] = []
  const repairs: AuthRepair[] = []
  const now = input.now ?? Date.now()
  const storedMain = findStoredMainCredential(input.storage)

  let authNeedsRestore = false
  if (!input.auth) {
    findings.push({
      code: 'auth-slot-missing',
      message: "OpenCode's OpenAI auth slot is missing.",
    })
    authNeedsRestore = true
  } else if (input.auth.type !== 'oauth') {
    findings.push({
      code: 'auth-slot-not-oauth',
      message: "OpenCode's OpenAI auth slot is not OAuth.",
    })
    authNeedsRestore = true
  } else if (
    !input.auth.refresh ||
    !input.storage?.accounts.some(
      (account) =>
        isOAuthAccount(account) && account.refresh === input.auth?.refresh,
    )
  ) {
    findings.push({
      code: 'main-refresh-not-in-store',
      message:
        "OpenCode's main refresh token is absent from the account store.",
    })
    authNeedsRestore = true
  }

  if (authNeedsRestore && storedMain) {
    const repair: AuthRepair = { type: 'restore-main-credential' }
    repairs.push(repair)
    const target = findings.find(
      (finding) =>
        finding.code === 'auth-slot-missing' ||
        finding.code === 'auth-slot-not-oauth' ||
        finding.code === 'main-refresh-not-in-store',
    )
    if (target) target.repair = repair
  }

  const accounts = input.storage?.accounts ?? []
  if (accounts.length === 0) {
    findings.push({
      code: 'no-accounts',
      message: 'The account store has no accounts.',
    })
  } else if (!accounts.some((account) => account.enabled !== false)) {
    findings.push({
      code: 'no-enabled-accounts',
      message: 'The account store has no enabled accounts.',
    })
  }

  for (const account of accounts) {
    if (!isOAuthAccount(account)) continue
    if (!hasArmedNonTransientBackoff(account, now)) continue
    const repair: AuthRepair = {
      type: 'clear-refresh-backoff',
      accountId: account.id,
    }
    repairs.push(repair)
    findings.push({
      code: 'armed-non-transient-refresh-backoff',
      accountId: account.id,
      message: `Account ${account.id} has an armed non-transient refresh backoff.`,
      repair,
    })
  }

  const orphanStateIds = [...(input.orphanStateIds ?? [])]
  if (orphanStateIds.length > 0) {
    const repair: AuthRepair = {
      type: 'prune-orphan-state-ids',
      ids: orphanStateIds,
    }
    repairs.push(repair)
    findings.push({
      code: 'orphan-state-ids',
      message: `State contains ids absent from the config roster: ${orphanStateIds.join(', ')}.`,
      repair,
    })
  }

  return { findings, repairs }
}

export function formatAuthDoctorReport(report: AuthDoctorReport): string {
  const lines = ['OpenAI auth doctor']
  if (report.findings.length === 0) {
    lines.push('No problems found.')
    return lines.join('\n')
  }
  for (const finding of report.findings) {
    const repair = finding.repair ? ' (repair available)' : ''
    lines.push(`- ${finding.message}${repair}`)
  }
  return lines.join('\n')
}
