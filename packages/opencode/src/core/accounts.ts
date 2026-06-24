import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { createLogger } from '../logger.ts'
import { writeJsonAtomic } from './atomic-write'
import {
  buildQuotaOperationError,
  buildRefreshOperationError,
  formatRefreshBackoffMessage,
  isTransientQuotaError,
  quotaBackoffActive,
  refreshBackoffActive,
} from './backoff.ts'
import { extractAccountId } from './oauth'
import type {
  ProviderQuotaFn,
  ProviderRefreshFn,
  QuotaWindowName,
} from './provider.ts'
import { PRIMARY, SECONDARY } from './provider.ts'
import { acquireRefreshFileLock } from './refresh-file-lock'

const logR = createLogger('refresh')
const SAVE_ACCOUNTS_LOCK_TTL_MS = 10_000
const SAVE_ACCOUNTS_LOCK_RETRY_MS = 50

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export const ACCOUNT_FILE_NAME = 'openai-auth.json'
export const ACCOUNT_STATE_FILE_NAME = 'openai-auth-state.json'

function getConfigDir() {
  if (process.env.OPENCODE_CONFIG_DIR?.trim()) {
    return process.env.OPENCODE_CONFIG_DIR.trim()
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
    'opencode',
  )
}

export function getAccountStoragePath() {
  return (
    process.env.OPENCODE_OPENAI_AUTH_FILE?.trim() ||
    join(getConfigDir(), ACCOUNT_FILE_NAME)
  )
}

export function getAccountStatePath(configPath = getAccountStoragePath()) {
  const explicit = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE?.trim()
  if (explicit) return explicit
  return deriveStatePath(configPath)
}

/** Derive the state-file path from the config path without reading env vars. */
function deriveStatePath(configPath: string): string {
  return configPath.endsWith(ACCOUNT_FILE_NAME)
    ? join(dirname(configPath), ACCOUNT_STATE_FILE_NAME)
    : `${configPath}.state.json`
}

// ---------------------------------------------------------------------------
// Re-export the widened QuotaWindowName + consts from the injection seam
// ---------------------------------------------------------------------------

export type { QuotaWindowName }
export { PRIMARY, SECONDARY }

// ---------------------------------------------------------------------------
// Window / quota types
// ---------------------------------------------------------------------------

export type AccountQuotaWindow = {
  usedPercent: number
  remainingPercent: number
  resetsAt?: string
  checkedAt: number
}

export type OAuthQuotaSnapshot = Partial<
  Record<QuotaWindowName, AccountQuotaWindow>
>

// ---------------------------------------------------------------------------
// Account types
// ---------------------------------------------------------------------------

export type AccountBase = {
  id: string
  label?: string
  enabled?: boolean
  addedAt?: number
  lastUsed?: number
  /** Stable ChatGPT account identifier extracted from the OAuth token claims. */
  accountId?: string
}

export type AccountOperationError = {
  message: string
  checkedAt: number
  nextRetryAt?: number
  retryCount?: number
  tokenHash?: string
}

export type OAuthAccount = AccountBase & {
  type: 'oauth'
  access?: string
  refresh: string
  expires?: number
  lastRefreshedAt?: number
  lastRefreshError?: AccountOperationError
  lastQuotaRefreshError?: AccountOperationError
  quota?: Partial<Record<QuotaWindowName, AccountQuotaWindow>>
}

export type ApiKeyAccount = AccountBase & {
  type: 'api'
  apiKey?: string
  baseURL: string
  authHeader?: 'authorization-bearer' | 'x-api-key'
}

export type FallbackAccount = OAuthAccount | ApiKeyAccount

export function isOAuthAccount(
  account: FallbackAccount,
): account is OAuthAccount {
  return account.type === 'oauth'
}

export function isApiKeyAccount(
  account: FallbackAccount,
): account is ApiKeyAccount {
  return account.type === 'api'
}

export function isValidApiBaseURL(value: string | undefined) {
  const raw = value?.trim()
  if (!raw) return false
  try {
    const url = new URL(raw)
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      !url.username &&
      !url.password
    )
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Storage types
// ---------------------------------------------------------------------------

export type RoutingMode = 'main-first' | 'fallback-first'

export type KillswitchThresholds = Partial<
  Record<QuotaWindowName | '5h' | '1w', number>
>

export type KillswitchConfig = {
  enabled?: boolean
  main?: KillswitchThresholds
  accounts?: Record<string, KillswitchThresholds>
}

export type AccountStorage = {
  version: 1
  main?: {
    type: 'opencode'
    provider: 'openai'
  }
  routing?: {
    mode?: RoutingMode
    activeId?: string
  }
  fallbackOn?: number[]
  refresh?: {
    enabled?: boolean
    intervalMinutes?: number
    refreshBeforeExpiryMinutes?: number
    mainLastRefreshError?: AccountOperationError
    mainRefreshLeaseId?: string
    mainRefreshLeaseUntil?: number
    mainRefreshLeaseTokenHash?: string
  }
  quota?: {
    enabled?: boolean
    checkIntervalMinutes?: number
    refreshEveryNRequests?: number
    minimumRemaining?: Partial<Record<QuotaWindowName | '5h' | '1w', number>>
    failClosedOnUnknownQuota?: boolean
    showToasts?: boolean
    mainQuota?: OAuthQuotaSnapshot
    mainQuotaCheckedAt?: number
    mainQuotaToken?: string
    mainLastQuotaApiError?: AccountOperationError
  }
  dump?: {
    enabled?: boolean
  }
  costZeroing?: {
    enabled?: boolean
  }
  killswitch?: KillswitchConfig
  logging?: {
    level?: string
  }
  cachekeep?: {
    enabled?: boolean
    subagents?: boolean
  }
  /** Stable ChatGPT account identifier of the main account (extracted from OAuth token). */
  mainAccountId?: string
  accounts: FallbackAccount[]
}

export function isCostZeroingEnabled(
  storage: Pick<AccountStorage, 'costZeroing'>,
): boolean {
  return storage.costZeroing?.enabled !== false
}

export type AccountRuntimeEntry = Partial<
  Pick<
    OAuthAccount,
    | 'access'
    | 'refresh'
    | 'expires'
    | 'lastUsed'
    | 'lastRefreshedAt'
    | 'lastRefreshError'
    | 'lastQuotaRefreshError'
    | 'quota'
  > &
    Pick<ApiKeyAccount, 'apiKey' | 'lastUsed'>
>

export type AccountRuntimeState = {
  version: 1
  main?: {
    quota?: OAuthQuotaSnapshot
    quotaCheckedAt?: number
    quotaToken?: string
    lastQuotaApiError?: AccountOperationError
    lastRefreshError?: AccountOperationError
    refreshLeaseId?: string
    refreshLeaseUntil?: number
    refreshLeaseTokenHash?: string
  }
  accounts?: Record<string, AccountRuntimeEntry>
}

export type AccountStateSaveScope = {
  mainQuota?: boolean
  mainRefresh?: boolean
  accounts?: true | string[]
}

export type AccountManagerOptions = {
  now?: () => number
  fetchImpl?: typeof fetch
  configPath?: string
  onFallbackStorageChanged?: () => void
  /** Provider token-refresh function (constructor-injected). */
  refreshFn?: ProviderRefreshFn
  /** Provider quota-fetch function (constructor-injected, OPTIONAL wham/usage supplement). */
  fetchQuotaFn?: ProviderQuotaFn
  /** QuotaManager instance for unified cache (constructor-injected). */
  quotaManager?: import('./quota-manager.ts').QuotaManager
}

export type AccountRefreshError = {
  accountId: string
  message: string
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_FALLBACK_ON = [401, 403, 429]
const DEFAULT_MINIMUM_REMAINING = {
  primary: 0,
  secondary: 0,
}
const DEFAULT_FAIL_CLOSED_ON_UNKNOWN_QUOTA = false

export const DEFAULT_KILLSWITCH_THRESHOLDS = {
  primary: 5,
  secondary: 10,
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function normalizeAccountBase(value: Record<string, unknown>): AccountBase {
  return {
    id:
      typeof value.id === 'string' && value.id.trim()
        ? value.id.trim()
        : randomUUID(),
    label: typeof value.label === 'string' ? value.label : undefined,
    enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
    addedAt: typeof value.addedAt === 'number' ? value.addedAt : undefined,
    lastUsed: typeof value.lastUsed === 'number' ? value.lastUsed : undefined,
    accountId:
      typeof value.accountId === 'string' ? value.accountId : undefined,
  }
}

function normalizeOperationError(
  value: unknown,
): AccountOperationError | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.message !== 'string') return undefined
  const checkedAt = Number(value.checkedAt)
  if (!Number.isFinite(checkedAt)) return undefined
  const nextRetryAt = Number(value.nextRetryAt)
  const retryCount = Number(value.retryCount)
  return {
    message: value.message,
    checkedAt,
    nextRetryAt: Number.isFinite(nextRetryAt) ? nextRetryAt : undefined,
    retryCount: Number.isFinite(retryCount) ? retryCount : undefined,
    tokenHash:
      typeof value.tokenHash === 'string' ? value.tokenHash : undefined,
  }
}

function normalizeQuota(value: unknown): OAuthAccount['quota'] {
  if (!isRecord(value)) return undefined
  const quota: OAuthAccount['quota'] = {}
  for (const key of ['primary', 'secondary'] as const) {
    const window = value[key]
    if (!isRecord(window)) continue
    const usedPercent = Number(window.usedPercent)
    const remainingPercent = Number(window.remainingPercent)
    const checkedAt = Number(window.checkedAt)
    if (
      !Number.isFinite(usedPercent) ||
      !Number.isFinite(remainingPercent) ||
      !Number.isFinite(checkedAt)
    ) {
      continue
    }
    quota[key] = {
      usedPercent,
      remainingPercent,
      checkedAt,
      resetsAt:
        typeof window.resetsAt === 'string' ? window.resetsAt : undefined,
    }
  }
  return Object.keys(quota).length ? quota : undefined
}

function normalizeAccount(value: unknown): FallbackAccount | null {
  if (!isRecord(value)) return null
  if (value.type === 'api') {
    const baseURL =
      typeof value.baseURL === 'string' ? value.baseURL.trim() : ''
    const apiKey = typeof value.apiKey === 'string' ? value.apiKey.trim() : ''
    if (!isValidApiBaseURL(baseURL)) return null
    const authHeader =
      value.authHeader === 'x-api-key' ? 'x-api-key' : 'authorization-bearer'
    return {
      ...normalizeAccountBase(value),
      type: 'api',
      apiKey: apiKey || undefined,
      baseURL,
      authHeader,
    }
  }

  if (value.type !== 'oauth') return null
  if (typeof value.refresh !== 'string' || !value.refresh.trim()) return null

  return {
    ...normalizeAccountBase(value),
    type: 'oauth',
    access: typeof value.access === 'string' ? value.access : undefined,
    refresh: value.refresh,
    expires: typeof value.expires === 'number' ? value.expires : undefined,
    lastRefreshedAt:
      typeof value.lastRefreshedAt === 'number'
        ? value.lastRefreshedAt
        : undefined,
    lastRefreshError: normalizeOperationError(value.lastRefreshError),
    lastQuotaRefreshError: normalizeOperationError(value.lastQuotaRefreshError),
    quota: normalizeQuota(value.quota),
  }
}

function normalizeStorage(value: unknown): AccountStorage | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null
  return {
    version: 1,
    main: { type: 'opencode', provider: 'openai' },
    routing: isRecord(value.routing) ? value.routing : undefined,
    fallbackOn: Array.isArray(value.fallbackOn)
      ? value.fallbackOn.filter((status) => Number.isInteger(status))
      : undefined,
    refresh: isRecord(value.refresh) ? value.refresh : undefined,
    quota: isRecord(value.quota) ? value.quota : undefined,
    dump: isRecord(value.dump) ? value.dump : undefined,
    costZeroing: isRecord(value.costZeroing) ? value.costZeroing : undefined,
    killswitch: isRecord(value.killswitch) ? value.killswitch : undefined,
    logging: isRecord(value.logging) ? value.logging : undefined,
    cachekeep: isRecord(value.cachekeep) ? value.cachekeep : undefined,
    mainAccountId:
      typeof value.mainAccountId === 'string' ? value.mainAccountId : undefined,
    accounts: value.accounts
      .map(normalizeAccount)
      .filter((account): account is FallbackAccount => account != null),
  }
}

// ---------------------------------------------------------------------------
// I/O helpers
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises'

async function readJsonIfPresent(path: string): Promise<{
  exists: boolean
  value: unknown
}> {
  try {
    return { exists: true, value: JSON.parse(await readFile(path, 'utf8')) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, value: null }
    }
    // Any other error (JSON parse failure, EACCES, etc.) must surface so
    // corruption or permission problems are not silently clobbered.
    throw error
  }
}

function objectWithDefinedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function mergeConfigAndState(
  configValue: unknown,
  stateValue: unknown,
): unknown {
  if (!isRecord(configValue)) return configValue
  const state = isRecord(stateValue) ? stateValue : {}
  const mainState = isRecord(state.main) ? state.main : undefined
  const stateAccounts = isRecord(state.accounts) ? state.accounts : {}

  const quotaConfig = isRecord(configValue.quota) ? configValue.quota : {}
  const refreshConfig = isRecord(configValue.refresh) ? configValue.refresh : {}
  const mainQuotaSource = mainState ?? quotaConfig
  const mainRefreshSource = mainState ?? refreshConfig

  const hasAccounts = Array.isArray(configValue.accounts)
  const accounts = hasAccounts
    ? (configValue.accounts as unknown[]).map((account) => {
        if (!isRecord(account)) return account
        const stateAccount: Record<string, unknown> =
          typeof account.id === 'string' && isRecord(stateAccounts[account.id])
            ? (stateAccounts[account.id] as Record<string, unknown>)
            : {}
        return { ...account, ...stateAccount }
      })
    : undefined

  return omitUndefinedTopLevel({
    ...configValue,
    refresh: objectWithDefinedEntries({
      ...refreshConfig,
      mainLastRefreshError: mainRefreshSource.lastRefreshError,
      mainRefreshLeaseId: mainRefreshSource.refreshLeaseId,
      mainRefreshLeaseUntil: mainRefreshSource.refreshLeaseUntil,
      mainRefreshLeaseTokenHash: mainRefreshSource.refreshLeaseTokenHash,
    }),
    quota: objectWithDefinedEntries({
      ...quotaConfig,
      mainQuota: mainQuotaSource.quota,
      mainQuotaCheckedAt: mainQuotaSource.quotaCheckedAt,
      mainQuotaToken: mainQuotaSource.quotaToken,
      mainLastQuotaApiError: mainQuotaSource.lastQuotaApiError,
    }),
    accounts,
  })
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

export async function loadAccounts(path = getAccountStoragePath()) {
  const config = await readJsonIfPresent(path)
  if (!config.exists) return null
  const state = await readJsonIfPresent(getAccountStatePath(path))
  return normalizeStorage(mergeConfigAndState(config.value, state.value))
}

function omitUndefinedTopLevel(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}

function accountConfig(account: FallbackAccount) {
  return objectWithDefinedEntries({
    id: account.id,
    label: account.label,
    type: account.type,
    enabled: account.enabled,
    addedAt: account.addedAt,
    accountId: account.accountId,
    baseURL: account.type === 'api' ? account.baseURL : undefined,
    authHeader: account.type === 'api' ? account.authHeader : undefined,
  })
}

function accountRuntimeState(account: FallbackAccount) {
  if (account.type === 'api') {
    return objectWithDefinedEntries({
      apiKey: account.apiKey,
      lastUsed: account.lastUsed,
    })
  }
  return objectWithDefinedEntries({
    access: account.access,
    refresh: account.refresh,
    expires: account.expires,
    lastUsed: account.lastUsed,
    lastRefreshedAt: account.lastRefreshedAt,
    lastRefreshError: account.lastRefreshError,
    lastQuotaRefreshError: account.lastQuotaRefreshError,
    quota: account.quota,
  })
}

function quotaSnapshotCheckedAt(quota: OAuthQuotaSnapshot | undefined) {
  return Math.max(
    quota?.primary?.checkedAt ?? 0,
    quota?.secondary?.checkedAt ?? 0,
  )
}

function copyRuntimeField<K extends keyof AccountRuntimeEntry>(
  target: AccountRuntimeEntry,
  source: AccountRuntimeEntry,
  key: K,
) {
  if (key in source) {
    target[key] = source[key]
  } else {
    delete target[key]
  }
}

function tokenFieldsMatch(
  existing: AccountRuntimeEntry,
  incoming: AccountRuntimeEntry,
) {
  return (
    existing.access === incoming.access &&
    existing.refresh === incoming.refresh &&
    existing.expires === incoming.expires &&
    existing.lastRefreshedAt === incoming.lastRefreshedAt
  )
}

function selectSameTokenState(
  existing: AccountRuntimeEntry,
  incoming: AccountRuntimeEntry,
) {
  if (!tokenFieldsMatch(existing, incoming)) return incoming
  if (!('lastRefreshError' in incoming)) return existing
  if (!('lastRefreshError' in existing)) return incoming
  return (incoming.lastRefreshError?.checkedAt ?? 0) >
    (existing.lastRefreshError?.checkedAt ?? 0)
    ? incoming
    : existing
}

function applyNewerTokenState(
  merged: AccountRuntimeEntry,
  existing: AccountRuntimeEntry,
  incoming: AccountRuntimeEntry,
) {
  const existingRefreshAt = existing.lastRefreshedAt ?? 0
  const incomingRefreshAt = incoming.lastRefreshedAt ?? 0
  const existingExpires = existing.expires ?? 0
  const incomingExpires = incoming.expires ?? 0
  const tokenSource =
    incomingRefreshAt > existingRefreshAt
      ? incoming
      : existingRefreshAt > incomingRefreshAt
        ? existing
        : incomingExpires > existingExpires
          ? incoming
          : existingExpires > incomingExpires
            ? existing
            : selectSameTokenState(existing, incoming)

  copyRuntimeField(merged, tokenSource, 'access')
  copyRuntimeField(merged, tokenSource, 'refresh')
  copyRuntimeField(merged, tokenSource, 'expires')
  copyRuntimeField(merged, tokenSource, 'lastRefreshedAt')
  copyRuntimeField(merged, tokenSource, 'lastRefreshError')
}

function mergeAccountRuntimeState(
  existing: unknown,
  incoming: AccountRuntimeEntry,
): AccountRuntimeEntry {
  if (!isRecord(existing)) return incoming
  const existingEntry = existing as AccountRuntimeEntry
  const existingQuotaCheckedAt = quotaSnapshotCheckedAt(existingEntry.quota)
  const incomingQuotaCheckedAt = quotaSnapshotCheckedAt(incoming.quota)
  const existingQuotaIsNewer = existingQuotaCheckedAt > incomingQuotaCheckedAt
  const merged: AccountRuntimeEntry = existingQuotaIsNewer
    ? {
        ...existingEntry,
        ...incoming,
        quota: existingEntry.quota,
        lastQuotaRefreshError: existingEntry.lastQuotaRefreshError,
      }
    : { ...existingEntry, ...incoming }

  if (!existingQuotaIsNewer && !('lastQuotaRefreshError' in incoming)) {
    delete merged.lastQuotaRefreshError
  }
  if (!('lastRefreshError' in incoming)) {
    delete merged.lastRefreshError
  }
  if (
    typeof existingEntry.lastUsed === 'number' &&
    (!(typeof incoming.lastUsed === 'number') ||
      existingEntry.lastUsed > incoming.lastUsed)
  ) {
    merged.lastUsed = existingEntry.lastUsed
  }

  applyNewerTokenState(merged, existingEntry, incoming)
  return merged
}

function configFromStorage(storage: AccountStorage): Record<string, unknown> {
  const refresh = storage.refresh
    ? objectWithDefinedEntries({
        enabled: storage.refresh.enabled,
        intervalMinutes: storage.refresh.intervalMinutes,
        refreshBeforeExpiryMinutes: storage.refresh.refreshBeforeExpiryMinutes,
      })
    : undefined
  const quota = storage.quota
    ? objectWithDefinedEntries({
        enabled: storage.quota.enabled,
        checkIntervalMinutes: storage.quota.checkIntervalMinutes,
        refreshEveryNRequests: storage.quota.refreshEveryNRequests,
        minimumRemaining: storage.quota.minimumRemaining,
        failClosedOnUnknownQuota: storage.quota.failClosedOnUnknownQuota,
        showToasts: storage.quota.showToasts,
      })
    : undefined

  return omitUndefinedTopLevel({
    version: 1,
    main: storage.main,
    routing: storage.routing,
    fallbackOn: storage.fallbackOn,
    refresh,
    quota,
    dump: storage.dump,
    costZeroing: storage.costZeroing,
    killswitch: storage.killswitch,
    logging: storage.logging,
    cachekeep: storage.cachekeep,
    mainAccountId: storage.mainAccountId,
    accounts: storage.accounts.map(accountConfig),
  })
}

function mergeStorageForSave(
  latest: AccountStorage | null,
  incoming: AccountStorage,
): AccountStorage {
  if (!latest) return incoming

  const accounts = new Map<string, FallbackAccount>()
  for (const account of latest.accounts) accounts.set(account.id, account)
  for (const account of incoming.accounts) accounts.set(account.id, account)

  return {
    ...latest,
    ...incoming,
    accounts: [...accounts.values()],
  }
}

async function acquireSaveAccountsLock(path: string) {
  const deadline = Date.now() + SAVE_ACCOUNTS_LOCK_TTL_MS
  while (Date.now() <= deadline) {
    const lock = await acquireRefreshFileLock({
      name: 'save',
      ttlMs: SAVE_ACCOUNTS_LOCK_TTL_MS,
      path,
    })
    if (lock) return lock

    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) break
    await sleep(Math.min(SAVE_ACCOUNTS_LOCK_RETRY_MS, remainingMs))
  }

  throw new Error(
    `Timed out acquiring account store lock for ${path}; refusing to overwrite newer account data`,
  )
}

function stateFromStorage(storage: AccountStorage): AccountRuntimeState {
  const accounts = Object.fromEntries(
    storage.accounts.map((account) => [
      account.id,
      accountRuntimeState(account),
    ]),
  )
  return {
    version: 1,
    main: objectWithDefinedEntries({
      quota: storage.quota?.mainQuota,
      quotaCheckedAt: storage.quota?.mainQuotaCheckedAt,
      quotaToken: storage.quota?.mainQuotaToken,
      lastQuotaApiError: storage.quota?.mainLastQuotaApiError,
      lastRefreshError: storage.refresh?.mainLastRefreshError,
      refreshLeaseId: storage.refresh?.mainRefreshLeaseId,
      refreshLeaseUntil: storage.refresh?.mainRefreshLeaseUntil,
      refreshLeaseTokenHash: storage.refresh?.mainRefreshLeaseTokenHash,
    }),
    accounts,
  }
}

export async function saveAccounts(
  storage: AccountStorage,
  path = getAccountStoragePath(),
) {
  // Serialize concurrent read-modify-write to prevent lost updates when
  // the CLI and a TUI command (or two commands) modify the store at once.
  //
  // Lock acquisition order: config-lock (outer) → state-lock (inner).
  // saveAccountState takes ONLY the state lock, so the order is always
  // config→state or state-only — no deadlock cycle.
  //
  // The state-lock is acquired BEFORE the state-file read so that the
  // read→write on the state file is atomic with respect to concurrent
  // saveAccountState callers. Without this, a concurrent saveAccountState
  // could write the state file in the window after saveAccounts read it
  // but before saveAccounts re-wrote it, producing a lost update.
  //
  // Snapshot the state path once (honoring OPENCODE_OPENAI_AUTH_STATE_FILE)
  // so the lock target and write target are identical within this call and
  // consistent with every other state-file accessor (loadAccounts,
  // saveAccountState, migrate — all use getAccountStatePath).
  const statePath = getAccountStatePath(path)
  const lock = await acquireSaveAccountsLock(path)
  try {
    const stateLock = await acquireSaveAccountsLock(statePath)
    try {
      // Read the config file (not under state-lock — config-lock covers it).
      const configJson = await readJsonIfPresent(path)
      // Read the state file under the state-lock so no concurrent
      // saveAccountState can interleave between this read and our write.
      const stateJson = await readJsonIfPresent(statePath)
      const latest = configJson.exists
        ? normalizeStorage(
            mergeConfigAndState(configJson.value, stateJson.value),
          )
        : null
      const merged = mergeStorageForSave(latest, storage)
      const existing = isRecord(configJson.value) ? configJson.value : {}
      const nextConfig = { ...existing, ...configFromStorage(merged) }
      await writeJsonAtomic(path, nextConfig)
      await writeJsonAtomic(statePath, stateFromStorage(merged))
    } finally {
      await stateLock.release()
    }
  } finally {
    await lock.release()
  }
}

function applyMainQuotaStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  const existingCheckedAt =
    typeof state.main.quotaCheckedAt === 'number'
      ? state.main.quotaCheckedAt
      : quotaSnapshotCheckedAt(state.main.quota)
  const incomingCheckedAt =
    typeof storage.quota?.mainQuotaCheckedAt === 'number'
      ? storage.quota.mainQuotaCheckedAt
      : quotaSnapshotCheckedAt(storage.quota?.mainQuota)
  if (existingCheckedAt > incomingCheckedAt) return

  state.main.quota = storage.quota?.mainQuota
  state.main.quotaCheckedAt = storage.quota?.mainQuotaCheckedAt
  state.main.quotaToken = storage.quota?.mainQuotaToken
  state.main.lastQuotaApiError = storage.quota?.mainLastQuotaApiError
}

function applyMainRefreshStatePatch(
  state: AccountRuntimeState,
  storage: AccountStorage,
) {
  state.main = state.main ?? {}
  state.main.lastRefreshError = storage.refresh?.mainLastRefreshError
  state.main.refreshLeaseId = storage.refresh?.mainRefreshLeaseId
  state.main.refreshLeaseUntil = storage.refresh?.mainRefreshLeaseUntil
  state.main.refreshLeaseTokenHash = storage.refresh?.mainRefreshLeaseTokenHash
}

function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(pruneUndefined)
  if (!isRecord(value)) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .map(([key, entry]) => [key, pruneUndefined(entry)]),
  )
}

export async function saveAccountState(
  storage: AccountStorage,
  path = getAccountStoragePath(),
  scope: AccountStateSaveScope = {
    mainQuota: true,
    mainRefresh: true,
    accounts: true,
  },
) {
  const statePath = getAccountStatePath(path)
  // Serialize concurrent read-modify-write on the state file to prevent lost
  // updates when two callers (e.g. quota push + sidebar refresh) race.
  const lock = await acquireSaveAccountsLock(statePath)
  try {
    const existing = (await readJsonIfPresent(statePath)).value
    const next: AccountRuntimeState = isRecord(existing)
      ? ({ ...existing, version: 1 } as AccountRuntimeState)
      : { version: 1 }

    if (scope.mainQuota) applyMainQuotaStatePatch(next, storage)
    if (scope.mainRefresh) applyMainRefreshStatePatch(next, storage)

    if (scope.accounts) {
      const ids = scope.accounts === true ? null : new Set(scope.accounts)
      next.accounts = { ...(isRecord(next.accounts) ? next.accounts : {}) }
      for (const account of storage.accounts) {
        if (ids && !ids.has(account.id)) continue
        next.accounts[account.id] = mergeAccountRuntimeState(
          next.accounts[account.id],
          accountRuntimeState(account),
        )
      }
      if (ids) {
        for (const id of ids) {
          if (!storage.accounts.some((account) => account.id === id)) {
            delete next.accounts[id]
          }
        }
      }
    }

    await writeJsonAtomic(statePath, pruneUndefined(next))
  } finally {
    await lock.release()
  }
}

// ---------------------------------------------------------------------------
// Fallback / quota policies
// ---------------------------------------------------------------------------

function getFallbackStatuses(storage: AccountStorage | null) {
  return storage?.fallbackOn?.length ? storage.fallbackOn : DEFAULT_FALLBACK_ON
}

export function shouldFallbackStatus(
  status: number,
  storage: AccountStorage | null,
) {
  return getFallbackStatuses(storage).includes(status)
}

function normalizeThresholds(storage: AccountStorage | null): {
  primary: number
  secondary: number
} {
  const configured = storage?.quota?.minimumRemaining || {}
  return {
    primary:
      configured.primary ??
      configured['5h'] ??
      DEFAULT_MINIMUM_REMAINING.primary,
    secondary:
      configured.secondary ??
      configured['1w'] ??
      DEFAULT_MINIMUM_REMAINING.secondary,
  }
}

function quotaEnabled(storage: AccountStorage | null) {
  return storage?.quota?.enabled !== false
}

function failClosedOnUnknownQuota(storage: AccountStorage | null) {
  return (
    storage?.quota?.failClosedOnUnknownQuota ??
    DEFAULT_FAIL_CLOSED_ON_UNKNOWN_QUOTA
  )
}

export function quotaSnapshotPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
) {
  if (!quotaEnabled(storage)) return true
  const thresholds = normalizeThresholds(storage)
  for (const key of ['primary', 'secondary'] as const) {
    const window = quota?.[key]
    if (!window) return !failClosedOnUnknownQuota(storage)
    if (window.remainingPercent < thresholds[key]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Killswitch
// ---------------------------------------------------------------------------

export function isKillswitchEnabled(storage: AccountStorage | null) {
  return storage?.killswitch?.enabled === true
}

function normalizeKillswitchThresholds(
  thresholds: KillswitchThresholds | undefined,
): { primary: number; secondary: number } {
  return {
    primary:
      thresholds?.primary ??
      thresholds?.['5h'] ??
      DEFAULT_KILLSWITCH_THRESHOLDS.primary,
    secondary:
      thresholds?.secondary ??
      thresholds?.['1w'] ??
      DEFAULT_KILLSWITCH_THRESHOLDS.secondary,
  }
}

function getKillswitchThresholdsForAccount(
  storage: AccountStorage | null,
  accountId?: string,
): { primary: number; secondary: number } {
  if (!storage?.killswitch) return DEFAULT_KILLSWITCH_THRESHOLDS
  if (accountId && storage.killswitch.accounts?.[accountId]) {
    return normalizeKillswitchThresholds(storage.killswitch.accounts[accountId])
  }
  return normalizeKillswitchThresholds(storage.killswitch.main)
}

export function killswitchPassesPolicy(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  accountId?: string,
) {
  if (!isKillswitchEnabled(storage)) return true
  const thresholds = getKillswitchThresholdsForAccount(storage, accountId)
  let sawUnknownWindow = false
  for (const key of ['primary', 'secondary'] as const) {
    const window = quota?.[key]
    if (!window) {
      sawUnknownWindow = true
      continue
    }
    if (window.remainingPercent < thresholds[key]) return false
  }
  if (sawUnknownWindow) return !failClosedOnUnknownQuota(storage)
  return true
}

export function killswitchRetryAfterSeconds(
  mainQuota: OAuthQuotaSnapshot | undefined,
  fallbackAccounts: Array<{ quota?: OAuthQuotaSnapshot }>,
  now: number,
): number {
  const resetTimes: number[] = []
  const allQuotas = [mainQuota, ...fallbackAccounts.map((a) => a.quota)]
  for (const quota of allQuotas) {
    for (const key of ['primary', 'secondary'] as const) {
      const resetStr = quota?.[key]?.resetsAt
      if (!resetStr) continue
      const resetTime = Date.parse(resetStr)
      if (Number.isFinite(resetTime) && resetTime > now) {
        resetTimes.push(resetTime)
      }
    }
  }
  if (resetTimes.length === 0) return 300
  const earliest = Math.min(...resetTimes)
  return Math.max(1, Math.ceil((earliest - now) / 1000))
}

// ---------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------

/**
 * Content discriminator: an openai-auth.json is recognized as an account store
 * if it contains BOTH a `version` key AND an `accounts` key. Otherwise it is
 * treated as a settings-only config file.
 */
function isAccountStore(value: Record<string, unknown>): boolean {
  return typeof value.version === 'number' && Array.isArray(value.accounts)
}

/**
 * Migrate an existing single-slot token into the multi-account store.
 *
 * Reads the existing token via the caller-provided `getAuth` (the ONLY
 * read path — there is no `client.auth.get`).  If a token exists and the
 * config file is NOT yet an account store (content discriminator), seeds
 * it as the primary OAuth account.
 *
 * Idempotent: a second run is a no-op because the content discriminator
 * will already match.
 *
 * Tolerates expired/revoked tokens (migrates them; refresh handles validity).
 *
 * Guards against first-run races with `acquireRefreshFileLock`.
 */
export async function migrateIfNeeded(
  existingToken:
    | { type: 'oauth'; access: string; refresh: string; expires: number }
    | undefined,
  path = getAccountStoragePath(),
) {
  const lock = await acquireRefreshFileLock({
    name: 'migrate',
    ttlMs: 30_000,
    path,
  })
  if (!lock) return // another process is already migrating

  try {
    const existing = await readJsonIfPresent(path)
    if (existing.exists && isRecord(existing.value)) {
      if (isAccountStore(existing.value)) return // already migrated
    }

    if (!existingToken) return // no token to migrate

    const storage: AccountStorage = {
      version: 1,
      main: { type: 'opencode', provider: 'openai' },
      accounts: [],
    }

    // Extract the stable ChatGPT account id from the main token so we
    // can reject attempts to add main as a fallback later.
    if (existingToken.access) {
      const accountId = extractAccountId({
        id_token: '',
        access_token: existingToken.access,
        refresh_token: existingToken.refresh,
      })
      if (accountId) storage.mainAccountId = accountId
    }

    // Merge with existing transport keys so saving the account store preserves webSearch/webSockets/rawWebSocket/dump/dumpDir.
    const existingFields =
      existing.exists && isRecord(existing.value) ? existing.value : {}
    const nextConfig = { ...existingFields, ...configFromStorage(storage) }
    await writeJsonAtomic(path, nextConfig)
    await writeJsonAtomic(getAccountStatePath(path), stateFromStorage(storage))
  } finally {
    await lock.release()
  }
}

// ---------------------------------------------------------------------------
// FallbackAccountManager helpers
// ---------------------------------------------------------------------------

function refreshEnabled(storage: AccountStorage | null) {
  return storage?.refresh?.enabled !== false
}

function refreshBeforeExpiryMs(storage: AccountStorage | null) {
  return (storage?.refresh?.refreshBeforeExpiryMinutes ?? 240) * 60_000
}

function jitterMs(maxMs: number) {
  return Math.floor(Math.random() * (maxMs + 1))
}

function tokenNeedsRefresh(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
) {
  return (
    !account.access ||
    !account.expires ||
    account.expires - now <= refreshBeforeExpiryMs(storage)
  )
}

function hasUnexpiredAccessToken(account: OAuthAccount, now: number) {
  return Boolean(
    account.access &&
      typeof account.expires === 'number' &&
      account.expires > now,
  )
}

function isMainAccountFallback(storage: AccountStorage, account: OAuthAccount) {
  return Boolean(
    storage.mainAccountId &&
      account.accountId &&
      account.accountId === storage.mainAccountId,
  )
}

function updateStoredAccount(storage: AccountStorage, account: OAuthAccount) {
  const idx = storage.accounts.findIndex(
    (candidate) => candidate.id === account.id,
  )
  if (idx !== -1) {
    storage.accounts[idx] = account
  }
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function recordRefreshError(
  account: OAuthAccount,
  error: unknown,
  now: number,
) {
  account.lastRefreshError = buildRefreshOperationError({
    error,
    now,
    refreshToken: account.refresh,
    previous: account.lastRefreshError,
  })
}

function recordQuotaRefreshError(
  account: OAuthAccount,
  error: unknown,
  now: number,
) {
  account.lastQuotaRefreshError = buildQuotaOperationError({
    error,
    now,
    previous: account.lastQuotaRefreshError,
  })
  // Only a token-refresh-step failure (isRefreshError===true, tagged at the
  // throw site in codexRefreshFn) arms the refresh backoff. A quota-endpoint
  // 401 must NOT arm it: isTransientRefreshError(401)===false would set a
  // long non-transient delay, and refreshBackoffActive would then block the
  // very refresh the 401 implies is needed — leaving the bad token stuck.
  // The quota backoff (buildQuotaOperationError above) already throttles the
  // quota endpoint for all non-refresh failures.
  const e = error as { isRefreshError?: boolean } | null | undefined
  if (e?.isRefreshError === true) {
    recordRefreshError(account, error, now)
  }
}

function fallbackRefreshLockName(accountId: string) {
  return `fallback-oauth-refresh-${createHash('sha256')
    .update(accountId)
    .digest('base64url')
    .slice(0, 16)}`
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _clampPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value)))
}

function cachedQuotaWindowStillRelevant(
  window: AccountQuotaWindow | undefined,
  now: number,
) {
  if (!window) return false
  if (!window.resetsAt) return true
  const resetTime = Date.parse(window.resetsAt)
  return Number.isFinite(resetTime) ? resetTime > now : true
}

function cachedQuotaSnapshotStillRelevant(
  quota: OAuthQuotaSnapshot | undefined,
  now: number,
) {
  if (!quota) return false
  return (
    cachedQuotaWindowStillRelevant(quota[PRIMARY], now) ||
    cachedQuotaWindowStillRelevant(quota[SECONDARY], now)
  )
}

function quotaSnapshotIsFresh(
  quota: OAuthQuotaSnapshot | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  if (!quota) return false
  const intervalMinutes = storage?.quota?.checkIntervalMinutes ?? 5
  const staleAfterMs = Math.max(1, intervalMinutes) * 60_000
  const checkedAt = Math.max(
    quota[PRIMARY]?.checkedAt ?? 0,
    quota[SECONDARY]?.checkedAt ?? 0,
  )
  return now - checkedAt < staleAfterMs
}

function quotaIsStale(
  account: OAuthAccount,
  storage: AccountStorage | null,
  now: number,
) {
  return !quotaSnapshotIsFresh(account.quota, storage, now)
}

function canUseCachedQuotaAfterRefreshError(
  account: OAuthAccount,
  storage: AccountStorage | null,
  error: unknown,
  now: number,
) {
  return (
    isTransientQuotaError(error) &&
    quotaSnapshotPassesPolicy(account.quota, storage) &&
    cachedQuotaSnapshotStillRelevant(account.quota, now)
  )
}

export function getQuotaCheckIntervalMs(storage: AccountStorage | null) {
  const minutes = storage?.quota?.checkIntervalMinutes ?? 5
  return Math.max(1, minutes) * 60_000
}

// ---------------------------------------------------------------------------
// Background constants
// ---------------------------------------------------------------------------

const BACKGROUND_TICK_MS = 60_000
const BACKGROUND_TICK_JITTER_MS = 60_000
const FALLBACK_REFRESH_LOCK_TTL_MS = 10 * 60_000
const FALLBACK_REFRESH_JOIN_WAIT_MS = 10_000
const FALLBACK_REFRESH_JOIN_POLL_MS = 100
const DEFAULT_REFRESH_INTERVAL_MINUTES = 10

export function getRefreshIntervalMs(storage: AccountStorage | null) {
  const minutes =
    storage?.refresh?.intervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES
  return Math.max(1, minutes) * 60_000
}

// ---------------------------------------------------------------------------
// FallbackAccountManager
// ---------------------------------------------------------------------------

const _setRefreshLockRenewalTimeout = globalThis.setTimeout.bind(globalThis)
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const _clearRefreshLockRenewalTimeout = globalThis.clearTimeout.bind(globalThis)

export class FallbackAccountManager {
  private readonly now: () => number
  private readonly fetchImpl: typeof fetch
  private readonly configPath: string
  private readonly refreshPromises = new Map<string, Promise<OAuthAccount>>()
  private refreshTimer: ReturnType<typeof setInterval> | null = null
  private quotaTimer: ReturnType<typeof setInterval> | null = null
  readonly quotaManager: import('./quota-manager.ts').QuotaManager | null
  private readonly onFallbackStorageChanged: (() => void) | undefined
  private readonly options: AccountManagerOptions

  constructor(options: AccountManagerOptions = {}) {
    this.options = options
    this.now = options.now ?? Date.now
    this.fetchImpl = options.fetchImpl ?? fetch
    this.configPath = options.configPath ?? getAccountStoragePath()
    this.quotaManager = options.quotaManager ?? null
    this.onFallbackStorageChanged = options.onFallbackStorageChanged
  }

  /**
   * Seed QuotaManager from persisted account.quota if no cache entry exists
   * yet. Prevents unnecessary API calls when the on-disk snapshot is fresh.
   */
  private seedFallbackQuota(
    account: OAuthAccount,
    storage: AccountStorage,
  ): void {
    if (!this.quotaManager) return
    if (!account.quota) return
    const checkedAt = Math.max(
      account.quota[PRIMARY]?.checkedAt ?? 0,
      account.quota[SECONDARY]?.checkedAt ?? 0,
    )
    if (checkedAt <= 0) return
    const existing = this.quotaManager.getFallback(account.id, account.access)
    if (existing && existing.checkedAt >= checkedAt) return
    this.quotaManager.setFallback(
      account.id,
      {
        quota: account.quota,
        refreshAfter: checkedAt + getQuotaCheckIntervalMs(storage),
        checkedAt,
      },
      account.access,
    )
  }

  async load() {
    return loadAccounts(this.configPath)
  }

  async save(storage: AccountStorage, accountIds?: string[]) {
    await saveAccountState(storage, this.configPath, {
      accounts: accountIds ?? true,
    })
  }

  startBackgroundRefresh() {
    const run = async () => {
      await this.refreshDueAccounts()
      // quota auto-runners are passive-only (gated behind fetchQuotaFn injection)
      if (this.options.fetchQuotaFn) {
        await this.refreshQuotaForDueAccounts()
      }
    }
    void run().catch(() => {})
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        void run().catch(() => {})
      }, BACKGROUND_TICK_MS + jitterMs(BACKGROUND_TICK_JITTER_MS))
      if ('unref' in this.refreshTimer) this.refreshTimer.unref()
    }
  }

  stopBackgroundRefresh() {
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.quotaTimer) clearInterval(this.quotaTimer)
    this.refreshTimer = null
    this.quotaTimer = null
  }

  async getUsableFallbackAccounts(existingStorage?: AccountStorage | null) {
    const storage =
      existingStorage !== undefined ? existingStorage : await this.load()
    if (!storage) return []
    const usable: OAuthAccount[] = []
    let changed = false

    for (const account of storage.accounts) {
      if (account.enabled === false || !isOAuthAccount(account)) continue
      if (isMainAccountFallback(storage, account)) continue
      let refreshFailed = false
      let candidate = account
      try {
        if (tokenNeedsRefresh(candidate, storage, this.now())) {
          const refreshError = candidate.lastRefreshError
          if (
            refreshError &&
            refreshBackoffActive(refreshError, candidate.refresh, this.now())
          ) {
            refreshFailed = true
            throw new Error(
              formatRefreshBackoffMessage(refreshError, this.now()),
            )
          }
          try {
            candidate = await this.refreshAccount(candidate, storage)
            changed = true
          } catch (error) {
            refreshFailed = true
            const stored = storage.accounts.find(
              (candidate): candidate is OAuthAccount =>
                candidate.id === account.id && isOAuthAccount(candidate),
            )
            if (
              stored &&
              !refreshBackoffActive(
                stored.lastRefreshError,
                stored.refresh,
                this.now(),
              )
            ) {
              recordRefreshError(stored, error, this.now())
              updateStoredAccount(storage, stored)
              changed = true
            }
            throw error
          }
        }
        this.seedFallbackQuota(candidate, storage)
        // Quota is pushed per-turn from transport headers/WS frames; selection
        // filters stale candidates without ever pulling quota from the network.
        if (
          this.accountPassesQuotaPolicy(
            this.quotaPolicyAccount(candidate),
            storage,
          )
        )
          usable.push(candidate)
      } catch (error) {
        const hasUsableCandidateToken = hasUnexpiredAccessToken(
          candidate,
          this.now(),
        )
        if (refreshFailed) {
          if (!hasUsableCandidateToken) continue
        } else if (!hasUsableCandidateToken) {
          continue
        }
        if (
          canUseCachedQuotaAfterRefreshError(
            candidate,
            storage,
            error,
            this.now(),
          )
        ) {
          logR.debug('fallback quota using cached quota after refresh error', {
            pid: process.pid,
            accountId: candidate.id,
            error: formatErrorMessage(error),
          })
          usable.push(candidate)
        } else if (!failClosedOnUnknownQuota(storage)) {
          usable.push(candidate)
        }
      }
    }

    if (changed) await this.save(storage)
    return usable
  }

  async markUsed(account: FallbackAccount) {
    const storage = await this.load()
    if (!storage) return
    const stored = storage.accounts.find(
      (candidate) => candidate.id === account.id,
    )
    if (!stored) return
    stored.lastUsed = this.now()
    await this.save(storage)
  }

  accountPassesQuotaPolicy(
    account: OAuthAccount,
    storage: AccountStorage | null,
  ) {
    return quotaSnapshotPassesPolicy(account.quota, storage)
  }

  /**
   * Return the account with its quota overlaid from the unified QuotaManager
   * cache (token-bound) when available, so quota-policy decisions use the same
   * source of truth as the staleness check. Falls back to the stored
   * account.quota when no manager is wired or the cache has no entry.
   */
  private quotaPolicyAccount(account: OAuthAccount): OAuthAccount {
    if (!this.quotaManager) return account
    const cached = this.quotaManager.getFallback(
      account.id,
      account.access,
    )?.quota
    return cached ? { ...account, quota: cached } : account
  }

  async refreshDueAccounts() {
    const storage = await this.load()
    if (!storage || !refreshEnabled(storage)) return
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false || !isOAuthAccount(account)) continue
      if (!tokenNeedsRefresh(account, storage, this.now())) continue
      if (
        refreshBackoffActive(
          account.lastRefreshError,
          account.refresh,
          this.now(),
        )
      ) {
        continue
      }
      try {
        logR.debug('fallback oauth background due', {
          pid: process.pid,
          accountId: account.id,
          expiresInMs: account.expires
            ? account.expires - this.now()
            : undefined,
        })
        await this.refreshAccount(account, storage)
        changed = true
      } catch (error) {
        logR.warn('fallback oauth background failed', {
          pid: process.pid,
          accountId: account.id,
          error: formatErrorMessage(error),
        })
        recordRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
      }
    }
    if (changed) await this.save(storage)
  }

  async refreshQuotaForDueAccounts() {
    const storage = await this.load()
    if (!storage || !quotaEnabled(storage)) return
    // Passive-mode guard: no fetchQuotaFn → cannot pull quota.
    if (!this.options.fetchQuotaFn) return
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false || !isOAuthAccount(account)) continue
      let next = account
      try {
        if (tokenNeedsRefresh(next, storage, this.now())) {
          if (
            refreshBackoffActive(
              next.lastRefreshError,
              next.refresh,
              this.now(),
            )
          ) {
            continue
          }
          next = await this.refreshAccount(next, storage)
          changed = true
        }
        if (quotaBackoffActive(next.lastQuotaRefreshError, this.now())) {
          continue
        }
        this.seedFallbackQuota(next, storage)
        const stale = this.quotaManager
          ? this.quotaManager.isFallbackStale(next.id, next.access)
          : quotaIsStale(next, storage, this.now())
        if (!stale) continue
        await this.refreshAccountQuota(next, storage)
        changed = true
      } catch (error) {
        recordQuotaRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
      }
    }
    if (changed) {
      await this.save(storage)
      this.onFallbackStorageChanged?.()
    }
  }

  async refreshQuotaForAllAccounts(options: { force?: boolean } = {}) {
    const storage = await this.load()
    const errors: AccountRefreshError[] = []
    if (!storage || !quotaEnabled(storage)) return { storage, errors }
    // Passive-mode guard: no fetchQuotaFn → cannot pull quota.
    if (!this.options.fetchQuotaFn) return { storage, errors }
    const force = options.force ?? false
    let changed = false
    for (const account of storage.accounts) {
      if (account.enabled === false || !isOAuthAccount(account)) continue
      let next = account
      try {
        if (tokenNeedsRefresh(next, storage, this.now())) {
          const refreshError = next.lastRefreshError
          if (
            refreshError &&
            refreshBackoffActive(refreshError, next.refresh, this.now())
          ) {
            throw new Error(
              formatRefreshBackoffMessage(refreshError, this.now()),
            )
          }
          next = await this.refreshAccount(next, storage)
          changed = true
        }
        if (!force && !quotaIsStale(next, storage, this.now())) {
          if (next.lastQuotaRefreshError) {
            next.lastQuotaRefreshError = undefined
            updateStoredAccount(storage, next)
            changed = true
          }
          continue
        }
        await this.refreshAccountQuota(next, storage)
        changed = true
      } catch (error) {
        recordQuotaRefreshError(account, error, this.now())
        updateStoredAccount(storage, account)
        changed = true
        errors.push({
          accountId: account.id,
          message: formatErrorMessage(error),
        })
      }
    }
    if (changed) await this.save(storage)
    return { storage, errors }
  }

  async refreshAccount(
    account: OAuthAccount,
    storage: AccountStorage,
    options: { force?: boolean } = {},
  ): Promise<OAuthAccount> {
    const existing = this.refreshPromises.get(account.id)
    if (existing) {
      const refreshed = await existing
      updateStoredAccount(storage, refreshed)
      return refreshed
    }

    const promise = this.refreshAccountNow(account, storage, options).finally(
      () => {
        this.refreshPromises.delete(account.id)
      },
    )
    this.refreshPromises.set(account.id, promise)
    const refreshed = await promise
    updateStoredAccount(storage, refreshed)
    return refreshed
  }

  private async waitForConcurrentFallbackRefresh(
    account: OAuthAccount,
    storage: AccountStorage,
    previous: OAuthAccount,
    options: { force?: boolean },
  ): Promise<OAuthAccount | null> {
    const deadline = Date.now() + FALLBACK_REFRESH_JOIN_WAIT_MS
    while (Date.now() < deadline) {
      await new Promise((resolve) =>
        setTimeout(resolve, FALLBACK_REFRESH_JOIN_POLL_MS),
      )
      const latestStorage = await this.load()
      const latestAccount = latestStorage?.accounts.find(
        (candidate): candidate is OAuthAccount =>
          candidate.id === account.id && isOAuthAccount(candidate),
      )
      if (!latestAccount) continue

      const changed =
        latestAccount.access !== previous.access ||
        latestAccount.refresh !== previous.refresh ||
        (latestAccount.expires ?? 0) > (previous.expires ?? 0) + 60_000
      if (
        changed &&
        (options.force ||
          !tokenNeedsRefresh(latestAccount, latestStorage, this.now()))
      ) {
        updateStoredAccount(storage, latestAccount)
        logR.debug('fallback oauth joined concurrent refresh', {
          pid: process.pid,
          accountId: latestAccount.id,
          expiresInMs: latestAccount.expires
            ? latestAccount.expires - this.now()
            : undefined,
        })
        return latestAccount
      }

      const refreshError = latestAccount.lastRefreshError
      if (
        refreshError &&
        refreshBackoffActive(refreshError, latestAccount.refresh, this.now())
      ) {
        updateStoredAccount(storage, latestAccount)
        throw new Error(formatRefreshBackoffMessage(refreshError, this.now()))
      }
    }
    return null
  }

  private async refreshAccountNow(
    account: OAuthAccount,
    storage: AccountStorage,
    options: { force?: boolean },
  ): Promise<OAuthAccount> {
    let latestStorage = await this.load()
    let latestAccount = latestStorage?.accounts.find(
      (candidate): candidate is OAuthAccount =>
        candidate.id === account.id && isOAuthAccount(candidate),
    )
    if (
      latestAccount &&
      !options.force &&
      !tokenNeedsRefresh(latestAccount, latestStorage, this.now())
    ) {
      updateStoredAccount(storage, latestAccount)
      return latestAccount
    }

    let sourceAccount = latestAccount ?? account
    const fileLock = await acquireRefreshFileLock({
      name: fallbackRefreshLockName(sourceAccount.id),
      ttlMs: FALLBACK_REFRESH_LOCK_TTL_MS,
      path: this.configPath,
      now: this.now,
      renew: true,
    })
    if (!fileLock) {
      logR.debug('fallback oauth refresh skipped file lock', {
        pid: process.pid,
        accountId: sourceAccount.id,
      })
      const concurrent = await this.waitForConcurrentFallbackRefresh(
        account,
        storage,
        sourceAccount,
        options,
      )
      if (concurrent) return concurrent
      throw new Error('Fallback OAuth refresh is already in progress')
    }

    try {
      latestStorage = await this.load()
      latestAccount = latestStorage?.accounts.find(
        (candidate): candidate is OAuthAccount =>
          candidate.id === account.id && isOAuthAccount(candidate),
      )
      if (
        latestAccount &&
        !options.force &&
        !tokenNeedsRefresh(latestAccount, latestStorage, this.now())
      ) {
        updateStoredAccount(storage, latestAccount)
        return latestAccount
      }

      sourceAccount = latestAccount ?? sourceAccount
      const providerRefreshFn =
        this.options.refreshFn ??
        (async () => {
          throw new Error('No refreshFn injected into FallbackAccountManager')
        })
      logR.debug('fallback oauth refresh request start', {
        pid: process.pid,
        accountId: sourceAccount.id,
        force: options.force === true,
        expiresInMs: sourceAccount.expires
          ? sourceAccount.expires - this.now()
          : undefined,
      })
      const refreshed = await providerRefreshFn({
        refreshToken: sourceAccount.refresh,
        fetchImpl: this.fetchImpl,
        now: this.now,
      })
      sourceAccount.access = refreshed.access
      sourceAccount.refresh = refreshed.refresh
      sourceAccount.expires = refreshed.expires
      sourceAccount.lastRefreshedAt =
        refreshed.expires - refreshed.expiresIn * 1000
      sourceAccount.lastRefreshError = undefined
      updateStoredAccount(storage, sourceAccount)
      await this.save(storage)
      logR.debug('fallback oauth refresh succeeded', {
        pid: process.pid,
        accountId: sourceAccount.id,
        expiresInMs: sourceAccount.expires
          ? sourceAccount.expires - this.now()
          : undefined,
      })
      return sourceAccount
    } finally {
      await fileLock.release()
    }
  }

  async refreshAccountQuota(account: OAuthAccount, storage: AccountStorage) {
    const target = account
    if (!target.access) {
      throw new Error(`Fallback account ${account.id} has no access token`)
    }
    // Passive-mode guard: no fetchQuotaFn → cannot pull quota.
    if (!this.options.fetchQuotaFn) {
      throw new Error(
        'No fetchQuotaFn injected — wham/usage supplement is disabled',
      )
    }
    const snapshotFn =
      this.options.fetchQuotaFn ??
      (async () => {
        throw new Error(
          'No fetchQuotaFn injected — wham/usage supplement is disabled',
        )
      })
    const fetchSnapshot = (accessToken: string) =>
      this.quotaManager
        ? this.quotaManager.refreshFallback(target.id, accessToken)
        : snapshotFn({
            accessToken,
            fetchImpl: this.fetchImpl,
            now: this.now,
          })
    try {
      if (!target.access) {
        throw new Error(`Fallback account ${account.id} has no access token`)
      }
      const quota = await fetchSnapshot(target.access)
      target.quota = quota
      target.lastQuotaRefreshError = undefined
      updateStoredAccount(storage, target)
      await this.save(storage)
    } catch (error) {
      recordQuotaRefreshError(account, error, this.now())
      updateStoredAccount(storage, account)
      throw error
    }
  }
}
