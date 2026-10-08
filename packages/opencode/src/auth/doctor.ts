import { readFile } from 'node:fs/promises'
import type {
  DoctorCheck,
  DoctorFinding,
} from '@cortexkit/common-auth/auth-menu'
import { quotaCodec } from '@cortexkit/common-auth/quota'
import { openPoolStore } from '@cortexkit/common-auth/store'
import {
  type AccountPaths,
  type AccountStorage,
  findPoolMainRow,
  isOAuthAccount,
  isPoolMainPlaceholder,
  isTombstoned,
  type mutateAccounts,
  NON_TRANSIENT_REFRESH_RETRY_DELAY_MS,
  type OAuthAccount,
  readConfigRosterIds,
  refreshBackoffActive,
} from '@cortexkit/openai-auth-core/internal'
import {
  POOL_UNTAGGED_TRANSFER_DISABLED_REASON,
  POOL_UNTAGGED_TRANSFER_REMEDY,
} from '../core/pool-migration'

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
  | 'main-pool-row-missing'
  | 'no-accounts'
  | 'no-enabled-accounts'
  | 'armed-non-transient-refresh-backoff'
  | 'orphan-state-ids'
  | 'tombstoned-host-slot'
  | 'tombstoned-account'
  | 'retired-custody-mode'
  | 'slot-transfer-origin-unknown'

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

/**
 * Whether the config still names the vault custody mode of older versions
 * (`claustrum.mode: "claustrum"`). Read from the file itself: the account
 * store no longer carries the setting, and its writers drop it.
 */
export async function readRetiredCustodyMode(
  paths: AccountPaths,
): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await readFile(paths.configPath, 'utf8'),
    ) as unknown
    return (
      objectRecord(parsed) &&
      objectRecord(parsed.claustrum) &&
      parsed.claustrum.mode === 'claustrum'
    )
  } catch {
    return false
  }
}

/** What to do about a tombstone, told the same way for the slot and for a row. */
const TOMBSTONE_REMEDY =
  'Connect this host to the Claustrum vault (`opencode auth login` > Connect to the Claustrum vault, or the Vault section of `/openai`) if the vault holds the account, or sign in to the account again.'

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
  /** Whether the config still names the removed custody mode. */
  retiredCustodyMode?: boolean
  now?: number
}): AuthDoctorReport {
  const findings: AuthDoctorFinding[] = []
  const repairs: AuthRepair[] = []
  const now = input.now ?? Date.now()
  const storedMain = findStoredMainCredential(input.storage)

  let authNeedsRestore = false
  if (isTombstoned(input.auth)) {
    // Left by the vault custody of older versions. It is never sent: the
    // main account is the pool row `main` when there is one, and the other
    // accounts serve when there is not.
    findings.push({
      code: 'tombstoned-host-slot',
      message: `OpenCode's OpenAI slot holds a tombstone left by the vault custody of an older version, not a credential; it is never sent. ${TOMBSTONE_REMEDY}`,
    })
  } else if (isPoolMainPlaceholder(input.auth)) {
    // The main account lives in the pool row `main` and the slot holds only
    // the migration's placeholder. That is healthy while the row exists.
    // Copying the row back into the slot is never offered: it would leave one
    // refresh token in two places, each refreshing it on its own.
    if (!findPoolMainRow(input.storage)) {
      findings.push({
        code: 'main-pool-row-missing',
        message:
          'The main account was moved into the account pool, but the pool has no usable `main` row.',
      })
    }
  } else if (!input.auth) {
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
    // Only a mismatch against a copy we actually hold is worth reporting. The
    // ordinary store keeps the main credential out of the fallback roster
    // entirely, so asking whether the roster contains it calls every healthy
    // install broken and points the operator at a repair that is not offered,
    // because the repair needs that same missing copy to restore from.
    storedMain &&
    (!input.auth.refresh || storedMain.refresh !== input.auth.refresh)
  ) {
    findings.push({
      code: 'main-refresh-not-in-store',
      message:
        "OpenCode's main credential does not match the copy in the account store.",
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
    if (!isOAuthAccount(account) || !isTombstoned(account)) continue
    findings.push({
      code: 'tombstoned-account',
      accountId: account.id,
      message: `Account ${account.id} holds a tombstone left by the vault custody of an older version, not a credential; it is never sent. ${TOMBSTONE_REMEDY}`,
    })
  }

  if (input.retiredCustodyMode) {
    findings.push({
      code: 'retired-custody-mode',
      message:
        'The config still selects the vault custody mode of an older version (`claustrum.mode`). It is ignored, and dropped at the next settings write; vault accounts are served once this host is connected to the Claustrum vault.',
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

export interface AuthDoctorCheckDeps {
  paths: AccountPaths
  /**
   * Whether the install is migrated. Its accounts are then pool rows the
   * store alone writes, so the two repairs that rewrite the legacy account
   * files are reported but not offered.
   */
  migrated: boolean
  readAuth(): Promise<AuthDetails>
  loadAccounts(paths: AccountPaths): Promise<AccountStorage | null>
  readStoreIds(paths: AccountPaths): Promise<StoreIds>
  /** The legacy writer; reached only on an install that has not migrated. */
  mutateAccounts: typeof mutateAccounts
  setMainAuth(credential: {
    refresh: string
    access?: string
    expires?: number
  }): Promise<void>
  now(): number
}

/**
 * The doctor as the shared auth menu runs it: one check that reads the slot
 * and the account files and reports `createAuthDoctorReport`'s findings, each
 * with its repair when one applies. A repair runs only when the operator
 * picks it.
 */
export function authDoctorChecks(deps: AuthDoctorCheckDeps): DoctorCheck[] {
  const repairFor = (repair: AuthRepair): DoctorFinding['repair'] => {
    if (repair.type === 'restore-main-credential')
      return {
        label: "Copy the stored main credential back into OpenCode's slot",
        apply: async () => {
          // Never over the account-pool placeholder: main then lives in the
          // pool row, and a second copy in the slot would be refreshed on its
          // own.
          if (isPoolMainPlaceholder(await deps.readAuth())) return
          const account = findStoredMainCredential(
            await deps.loadAccounts(deps.paths),
          )
          if (!account) return
          await deps.setMainAuth({
            refresh: account.refresh,
            access: account.access ?? '',
            expires: account.expires ?? 0,
          })
        },
      }
    if (deps.migrated) return undefined
    if (repair.type === 'prune-orphan-state-ids')
      return {
        label: `Drop the state entries of ${repair.ids.join(', ')}`,
        // The legacy writer keeps only roster ids in the state file.
        apply: async () => {
          await deps.mutateAccounts((current) => current, deps.paths)
        },
      }
    return {
      label: `Clear the refresh backoff of ${repair.accountId}`,
      apply: async () => {
        await deps.mutateAccounts((current) => {
          const account = current.accounts.find(
            (candidate): candidate is OAuthAccount =>
              candidate.id === repair.accountId && isOAuthAccount(candidate),
          )
          if (account) account.lastRefreshError = undefined
          return current
        }, deps.paths)
      },
    }
  }
  return [
    {
      id: 'openai-auth',
      run: async () => {
        const [storage, ids, auth, retiredCustodyMode] = await Promise.all([
          deps.loadAccounts(deps.paths),
          deps.readStoreIds(deps.paths),
          deps.readAuth(),
          readRetiredCustodyMode(deps.paths),
        ])
        const report = createAuthDoctorReport({
          auth: auth.type === 'missing' ? undefined : auth,
          storage,
          orphanStateIds: ids.orphanStateIds,
          retiredCustodyMode,
          now: deps.now(),
        })
        const pool = await openPoolStore({
          provider: 'openai',
          quota: quotaCodec,
          configPath: deps.paths.configPath,
          statePath: deps.paths.statePath,
        }).read()
        if (pool.status === 'ready') {
          for (const row of pool.rows) {
            if (row.disabledReason !== POOL_UNTAGGED_TRANSFER_DISABLED_REASON)
              continue
            report.findings.push({
              code: 'slot-transfer-origin-unknown',
              accountId: row.id,
              message: `Account ${row.id} was preserved disabled after an interrupted transfer with an untagged placeholder; sole ownership could not be established. ${POOL_UNTAGGED_TRANSFER_REMEDY}`,
            })
          }
        }
        return report.findings.map((finding) => {
          const repair = finding.repair ? repairFor(finding.repair) : undefined
          return {
            code: finding.code,
            message: finding.message,
            ...(finding.accountId !== undefined
              ? { accountId: finding.accountId }
              : {}),
            ...(repair ? { repair } : {}),
          }
        })
      },
    },
  ]
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
