import { createHash } from 'node:crypto'
import {
  mkdirSync,
  readFileSync,
  renameSync,
  type Stats,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { parseApplyRequest } from '@cortexkit/common-auth/commands'
import {
  adoptRpcServer,
  type RpcServerAdoption,
} from '@cortexkit/common-auth/rpc'
import {
  type ResetTargetIdentity,
  writeSettings,
} from '@cortexkit/openai-auth-core'
import {
  type AccountStorage,
  acquireRefreshFileLock,
  beginAccountLogin,
  buildRefreshOperationError,
  buildUserAgent,
  cacheKeepSettings,
  codexRefreshFn,
  errorMessage,
  extractAccountId,
  extractAccountIdFromClaims,
  type FallbackAccount,
  FallbackAccountManager,
  formatRefreshBackoffMessage,
  getKillswitchThresholdsForAccount,
  hashRefreshToken,
  isCompleteQuotaHeaderFrame,
  isCostZeroingEnabled,
  isKillswitchEnabled,
  isOAuthAccount,
  isRecord,
  isTombstoned,
  killswitchPassesPolicy,
  killswitchRetryAfterSeconds,
  loadAccounts,
  migrateIfNeeded,
  mutateAccounts,
  normalizeQuotaHeaders,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  type OpenAiVault,
  parseJwtClaims,
  type QuotaEntry,
  QuotaManager,
  type RefreshAllQuotaResult,
  type RoutingMode,
  refreshAllQuota,
  refreshBackoffActive,
  resolveMidStreamRateLimitResetAt,
  shouldFallbackStatus,
  type TokenResponse,
  TombstoneRefreshError,
  vaultStateDir,
  whamUsageFn,
} from '@cortexkit/openai-auth-core/internal'
import type {
  AuthOAuthResult,
  Hooks,
  Plugin,
  PluginInput,
} from '@opencode-ai/plugin'
import { createAuthMethods } from './auth/methods'
import {
  applyOpenAiMenu,
  menuText,
  OPENAI_COMMAND_NAME,
  type OpenCodeMenuContext,
  openOpenAiMenu,
} from './commands'
import { getConfigDir, getConfigPath, getSettings } from './config'
import { getAccountPaths, getAccountStatePath } from './core/account-paths'
import {
  acquireBackgroundRefreshLock,
  BackgroundQuotaRefresh,
  refreshPoolInBackground,
  refreshQuotaInBackground,
} from './core/background-quota-refresh'
import {
  buildKeepwarmCapture,
  createCacheKeepManager,
  getCacheKeepWindow,
  type OpenAICacheKeepManager,
  routedAccountForSession,
} from './core/cachekeep'
import {
  classifyMainAuthSlot,
  MAIN_REFRESH_LOCK_NAME,
  opencode1SlotForClient,
} from './core/host-slot'
import {
  PoolAccountSource,
  settlesWithin,
  VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS,
} from './core/pool-account-source'
import {
  migratedPoolRows,
  openAccountPool,
  poolMigrated,
  poolSettingsLocks,
} from './core/pool-accounts'
import {
  createPoolLifecycle,
  type PoolLifecycle,
  type PoolLifecycleDeps,
} from './core/pool-lifecycle'
import {
  findPoolMainRow,
  isPoolMainPlaceholder,
  MainAccountInPoolError,
  POOL_LOGIN_REQUIRED_MESSAGE,
  type PoolMainAccess,
  resolvePoolMainAccess,
  withoutPoolMainRow,
} from './core/pool-main'
import {
  adoptHostSlotLogin,
  migrateToPool,
  PoolTransferPendingError,
  poolPlaceholderWithoutMain,
  poolTransferPendingInConfigFile,
  reclaimExpiredPoolTransfer,
} from './core/pool-migration'
import { observationFromSnapshot } from './core/pool-quota'
import {
  type PoolBlockQuotas,
  type PoolPinPlacement,
  servePoolRequest,
} from './core/pool-request'
import { POOL_QUOTA_UNKNOWN_RETRY_SECONDS } from './core/pool-routing'
import { buildPoolSidebarMachineState } from './core/pool-sidebar'
import {
  type ProcessHeartbeatHandle,
  startProcessHeartbeat,
} from './core/process-heartbeat'
import { acquireOpenCodeVault } from './core/shared-vault'
import {
  decideStickyBreak,
  type StickyBreakDecision,
  selectStickyCandidate,
} from './core/sticky-routing'
import { migrationFenceOpen } from './core/version-fence'
import { DUMP_SESSION_HEADER, dumpCodexRequest } from './dump'
import { createLogger, setLogLevel } from './logger'
import { loadModelsDevCosts } from './model-costs'
import { resolvePromptContext } from './prompt-context'
import {
  drainNotifications,
  isTuiConnected,
  pushNotification,
} from './rpc/notifications'
import type { ApplyRequest, ApplyResult } from './rpc/protocol'
import { resolveRpcDir } from './rpc/rpc-dir'
import { RPC_SERVER_REGISTRY_KEY, startRpcServer } from './rpc/rpc-server'
import {
  type AccountQuota,
  applyStickyPinOverlay,
  clearSidebarStickyAssignment,
  createSidebarBookkeepingQueue,
  createSidebarStateCache,
  exhaustedQuotaResetAt,
  getSidebarState,
  getSidebarStateFile,
  HOT_PATH_READ_BUDGET_MS,
  hashSidebarSessionId,
  isQuotaExhausted,
  persistSidebarStickyAssignment,
  planSidebarStickyAssignmentFromSnapshot,
  type QuotaWindow,
  rememberStickyPin,
  removeSidebarActiveRouting,
  resolveSessionStickyAccount,
  type SidebarBookkeepingQueue,
  type SidebarMachineState,
  type SidebarSnapshot,
  type SidebarState,
  type StickyPinOverlay,
  setSidebarLegacyRouting,
  setSidebarMachineState,
  settleWithinBudget,
  upsertSidebarActiveRouting,
} from './sidebar-state'
import { stableStringify } from './util/stable-json'
import { uuidV7 } from './util/uuid-v7'
import { PackageVersion } from './version'
import { OpenAIWebSocketPool, orderCodexBody } from './ws-pool'

export const ALLOWED_MODELS = new Set([
  'gpt-5.5',
  'gpt-5.3-codex-spark',
  'gpt-5.4',
  'gpt-5.4-mini',
])
// The suffix-less gpt-5.6 model is rejected by the Codex OAuth backend
// ("not supported when using Codex with a ChatGPT account"); only the
// -luna/-sol/-terra variants work. Its -fast/-pro synthetics inherit the same
// api.id ("gpt-5.6"), so filtering on api.id drops them all at once while
// keeping the working variants (api.id gpt-5.6-luna, etc.).
// Same shape for gpt-6: the backend rejects the bare id ("not supported when
// using Codex with a ChatGPT account") and serves only the named variants
// (gpt-6-astra, gpt-6-sol, gpt-6-luna), so any -fast/-pro synthetics inheriting
// api.id "gpt-6" drop with it. gpt-6.1 is the same again: only gpt-6.1-sol is
// served, and the bare id (like gpt-6.1-luna and gpt-6.1-astra) answers 400.
export const DISALLOWED_MODELS = new Set(['gpt-5.6', 'gpt-6', 'gpt-6.1'])

/**
 * Whether a model (by its API id) is offered on a ChatGPT login: the allow
 * list, else not the deny list and a GPT version above 5.4. The caller drops
 * `pro` reasoning variants itself. Shared by the OpenCode 1 models hook and
 * the OpenCode 2 model transform.
 */
export function codexOAuthModelListed(apiId: string): boolean {
  if (ALLOWED_MODELS.has(apiId)) return true
  if (DISALLOWED_MODELS.has(apiId)) return false
  // The minor is optional: a major-only id like gpt-6-astra carries no
  // decimal, and requiring one silently dropped it from the catalogue even
  // though the backend serves it.
  const match = apiId.match(/^gpt-(\d+(?:\.\d+)?)/)
  const version = match?.[1]
  return version ? parseFloat(version) > 5.4 : false
}

/**
 * The context window a ChatGPT login gets for a model (by its id), or
 * undefined to keep the model's own. Shared by the OpenCode 1 models hook and
 * the OpenCode 2 model transform.
 */
export function codexOAuthModelLimit(
  modelId: string,
): { context: number; input: number; output: number } | undefined {
  if (modelId.includes('gpt-5.5'))
    return { context: 400_000, input: 272_000, output: 128_000 }
  // gpt-6-astra pays no long-context surcharge on the Codex backend, so it
  // keeps the full window that backend reports. Per OpenAI's enterprise rate
  // card, read 2026-09-05 at help.openai.com/en/articles/20001415 — section
  // "GPT-6 Astra — Codex long-context exception": "GPT-6 Astra usage in Codex
  // does not incur additional long-context multipliers above 272K input
  // tokens." The exemption is per-surface: the same model billed through the
  // platform API does pay it (developers.openai.com/api/docs/models/gpt-6-astra).
  //
  // That makes this correct for the DEFAULT endpoint. A `codexApiEndpoint`
  // override pointed at a relay or a differently-billed surface inherits this
  // window without inheriting the exemption, which is the operator's to
  // re-check.
  //
  // 872k is the Codex backend's own reported max_context_window, from
  // GET /backend-api/codex/models?client_version=<v>. The configured window
  // follows that reported number rather than the hard ceiling probing found
  // just above it (876,934 input tokens accepted on 2026-09-04), since the
  // reported number is the one the backend maintains. Input and output draw on
  // one shared budget, so `input` is that window minus the 128k output
  // reserve.
  if (modelId.includes('gpt-6-astra'))
    return { context: 872_000, input: 744_000, output: 128_000 }
  // The 5.6 family is NOT exempt — same rate card, same date: above 272k input
  // tokens it costs 2x input and 1.5x output ON THE WHOLE REQUEST, so `input`
  // is held under that line at 244k and `context` is that cap plus the 128k
  // output reserve. This is a cost decision, never a capability one —
  // gpt-5.6-sol accepted 861,550 input tokens when measured — so do not
  // "correct" these numbers upward to that ceiling without re-reading the rate
  // card first.
  //
  // gpt-6-sol and gpt-6-luna are NOT exempt either, even though they share
  // astra's 872k reported window. The rate card, re-read 2026-09-25, names
  // only GPT-6 Astra in its Codex long-context exception; the surcharge row
  // applies to everything else. Checking the model family is the wrong test -
  // it is the rate card's named list.
  //
  // gpt-6.1-sol is held here too. Its published pricing, read 2026-09-29 at
  // developers.openai.com/api/docs/models/gpt-6.1-sol, charges 2x input and
  // 1.5x output on the full request above 272K input tokens, and nothing names
  // it in a Codex exception. (The rate card itself could not be fetched that
  // day; re-check it before raising this.)
  if (
    modelId.includes('gpt-5.6') ||
    modelId.includes('gpt-6-sol') ||
    modelId.includes('gpt-6-luna') ||
    modelId.includes('gpt-6.1-sol')
  )
    return { context: 372_000, input: 244_000, output: 128_000 }
  return undefined
}

/**
 * Surfaced when a request would go to the wire with no credential.
 *
 * Fixed text on purpose. The host decides retries by matching this string
 * (opencode v1.18.30, session/retry.ts), so no account label, provider wording
 * or number may reach it - an operator-chosen id like `acct-429` would read as
 * retryable and hide a local defect behind a retry loop. Details go to the
 * transport log.
 */
export const EMPTY_BEARER_MESSAGE =
  'Refusing to send a request with no access token. This is a defect in the plugin, not a problem with the provider or the account; the transport log names the account and the path that produced it.'
// Exact models currently marked `use_responses_lite` in Codex's catalog. Read
// from the backend's own model list rather than assumed:
//   GET /backend-api/codex/models?client_version=<v>
// reports `use_responses_lite` per model, and every gpt-6 variant is marked true.
export const RESPONSES_LITE_MODELS: ReadonlySet<string> = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6.1-sol',
])
const OAUTH_DUMMY_KEY = 'opencode-oauth-dummy-key'
const CODEX_BETA_FEATURES = 'terminal_resize_reflow'
// gpt-6.1-sol requires Codex client >= 0.159.0: the backend's model catalog
// lists it from 0.159.0 and a request answers 400 ("not supported when using
// Codex with a ChatGPT account") at 0.158.0, measured 2026-09-29. Its catalog
// `minimal_client_version` says 0.153.0, which is wrong, so the catalog listing
// and a real request are the evidence, not that field. gpt-6-sol and gpt-6-luna
// need 0.155.0 and gpt-6-astra 0.153.0. Verified at 0.159.0 that gpt-6.1-sol,
// the three gpt-6 models, gpt-5.5 and the three 5.6 variants all complete, so
// one version serves the whole range. gpt-5.4, gpt-5.4-mini and
// gpt-5.3-codex-spark answer 400 at every version ("not supported when using
// Codex with a ChatGPT account") - a backend retirement, not something this
// version causes.
export const CODEX_VERSION = '0.159.0'
export const CODEX_USER_AGENT = `codex_exec/${CODEX_VERSION} (Debian 12.0.0; aarch64) unknown (codex_exec; ${CODEX_VERSION})`
const CODEX_SANDBOX = 'seccomp'
export const getMainRefreshLockName = () => MAIN_REFRESH_LOCK_NAME
export const MAIN_REFRESH_LOCK_TTL_MS = 2 * 60_000
export const MAIN_REFRESH_LEASE_TTL_MS = 90_000
const CONCURRENT_MAIN_REFRESH_WAIT_MS = 4_000
const CONCURRENT_MAIN_REFRESH_POLL_BASE_MS = 50
const AUTH_SET_MAX_ATTEMPTS = 3
const AUTH_SET_RETRY_BASE_MS = 25
// Fallback reset window for a mid-stream rate-limit mark when no cached quota
// snapshot resolves a real reset time. Conservative and short: if the account
// is still exhausted next turn, the next response.failed frame re-marks it.
const DEFAULT_MID_STREAM_RATE_LIMIT_RESET_MS = 60_000

const HANDLED_SENTINEL = '__OPENCODE_OPENAI_AUTH_COMMAND_HANDLED__'

let bootQuotaSeedStarted = false
let bootQuotaSeedPromise: Promise<unknown> | undefined

export function __bootQuotaSeedPromiseForTest(): Promise<unknown> | undefined {
  return bootQuotaSeedPromise
}

export function __resetBootQuotaSeedForTest(): void {
  bootQuotaSeedStarted = false
  bootQuotaSeedPromise = undefined
}

const logModels = createLogger('models')
let loggedCostRestoration = false
let warnedCostCatalogUnavailable = false

export class AuthPersistError extends Error {
  readonly code = 'OPENAI_AUTH_PERSIST_FAILED'

  constructor(cause: unknown) {
    super(
      'OpenAI OAuth token refreshed but could not be persisted; re-login required',
      { cause },
    )
    this.name = 'AuthPersistError'
  }
}

export type ResetTargetResolutionErrorKind =
  | 'unknown_account'
  | 'disabled_account'
  | 'non_oauth_account'
  | 'token_unavailable'

export class ResetTargetResolutionError extends Error {
  readonly code: ResetTargetResolutionErrorKind

  constructor(code: ResetTargetResolutionErrorKind, message: string) {
    super(message)
    this.name = 'ResetTargetResolutionError'
    this.code = code
  }
}

interface ResetTargetResolverDeps {
  getAuth: () => Promise<{
    type: string
    access?: string
    refresh?: string
    expires?: number
  }>
  refreshMainWithLease: () => Promise<{
    access: string
    refresh: string
    expires: number
  }>
  refreshFallbackAccount: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<OAuthAccount>
  /**
   * Refresh the pool row `main` while it serves as the main account. Defaults
   * to refreshFallbackAccount.
   */
  refreshPoolMainRow?: (
    account: OAuthAccount,
    storage: AccountStorage,
  ) => Promise<OAuthAccount>
  /**
   * On a migrated install, the pool row behind an account key (`main` is row
   * `main`) and its usable bearer, refreshed through the pool. Undefined when
   * the install is not migrated; the legacy slot and roster then apply.
   */
  poolAccess?: (accountKey: string) => Promise<PoolResetAccess | undefined>
  loadAccounts: typeof loadAccounts
  accountStoragePath: string
  accountStatePath: string
  now: () => number
}

function resetTargetNeedsRefresh(
  access: string | undefined,
  expires: number | undefined,
  storage: AccountStorage | null,
  now: number,
) {
  const refreshBeforeExpiryMs =
    (storage?.refresh?.refreshBeforeExpiryMinutes ?? 240) * 60_000
  return !access || !expires || expires - now <= refreshBeforeExpiryMs
}

/** A pool row as the reset-credit resolver sees it; `row` is absent when no row has the id. */
export interface PoolResetAccess {
  row?: {
    id: string
    type: 'oauth' | 'api'
    enabled: boolean
    label?: string
    identity?: string
  }
  token?: string
}

/** The reset target for a pool row, or the refusal the legacy resolver gives. */
function poolResetTarget(
  accountKey: string,
  pooled: PoolResetAccess,
): ResetTargetIdentity {
  const isMain = accountKey === 'main'
  const row = pooled.row
  const noToken = () =>
    new ResetTargetResolutionError(
      'token_unavailable',
      isMain
        ? 'Main OpenAI account has no usable access token.'
        : `Fallback account ${accountKey} has no usable access token.`,
    )
  if (!row) {
    if (isMain) throw noToken()
    throw new ResetTargetResolutionError(
      'unknown_account',
      `Fallback account ${accountKey} was not found.`,
    )
  }
  if (!row.enabled) {
    throw new ResetTargetResolutionError(
      'disabled_account',
      `${isMain ? 'Main' : 'Fallback'} account ${accountKey} is disabled.`,
    )
  }
  if (row.type !== 'oauth') {
    throw new ResetTargetResolutionError(
      'non_oauth_account',
      `${isMain ? 'Main' : 'Fallback'} account ${accountKey} is not an OAuth account.`,
    )
  }
  if (!pooled.token) throw noToken()
  const claims = parseJwtClaims(pooled.token)
  return {
    accountKey,
    label: isMain ? 'Main account' : (row.label ?? accountKey),
    accessToken: pooled.token,
    chatgptAccountId:
      row.identity ?? (claims ? extractAccountIdFromClaims(claims) : undefined),
  }
}

export function createResetTargetResolver(deps: ResetTargetResolverDeps) {
  // The main account while the slot holds the pool placeholder: the pool row
  // `main`, refreshed and resolved the way a fallback row is, but reported as
  // the main account.
  async function resolvePoolMainTarget(): Promise<ResetTargetIdentity> {
    const storage = await deps.loadAccounts({
      configPath: deps.accountStoragePath,
      statePath: deps.accountStatePath,
    })
    const row = findPoolMainRow(storage)
    if (!storage || !row || isTombstoned(row)) {
      throw new ResetTargetResolutionError(
        'token_unavailable',
        'Main OpenAI account has no usable access token.',
      )
    }
    let resolved = row
    if (
      resetTargetNeedsRefresh(
        resolved.access,
        resolved.expires,
        storage,
        deps.now(),
      )
    ) {
      resolved = await (deps.refreshPoolMainRow ?? deps.refreshFallbackAccount)(
        resolved,
        storage,
      )
    }
    if (!resolved.access) {
      throw new ResetTargetResolutionError(
        'token_unavailable',
        'Main OpenAI account has no usable access token.',
      )
    }
    const claims = parseJwtClaims(resolved.access)
    return {
      accountKey: 'main',
      label: 'Main account',
      accessToken: resolved.access,
      chatgptAccountId:
        resolved.accountId ??
        (claims ? extractAccountIdFromClaims(claims) : undefined),
    }
  }

  return async (accountKey: string): Promise<ResetTargetIdentity> => {
    const pooled = await deps.poolAccess?.(accountKey)
    if (pooled) return poolResetTarget(accountKey, pooled)
    if (accountKey === 'main') {
      const storage = await deps.loadAccounts({
        configPath: deps.accountStoragePath,
        statePath: deps.accountStatePath,
      })
      let auth = await deps.getAuth()
      if (isPoolMainPlaceholder(auth)) return resolvePoolMainTarget()
      if (auth.type !== 'oauth') {
        throw new ResetTargetResolutionError(
          'non_oauth_account',
          'Main OpenAI account is not authenticated with OAuth.',
        )
      }
      if (
        resetTargetNeedsRefresh(auth.access, auth.expires, storage, deps.now())
      ) {
        try {
          auth = { type: 'oauth', ...(await deps.refreshMainWithLease()) }
        } catch (error) {
          // The slot became the placeholder while this refresh waited.
          if (error instanceof MainAccountInPoolError) {
            return resolvePoolMainTarget()
          }
          throw error
        }
      }
      if (!auth.access) {
        throw new ResetTargetResolutionError(
          'token_unavailable',
          'Main OpenAI account has no usable access token.',
        )
      }
      // The access token's claims reflect the account authenticated right
      // now; the persisted mainAccountId lags a re-login until the next
      // storage write. Prefer the live identity, falling back to storage for
      // token shapes that carry no account claim.
      const claims = parseJwtClaims(auth.access)
      const liveAccountId = claims
        ? extractAccountIdFromClaims(claims)
        : undefined
      const freshStorage = await deps.loadAccounts({
        configPath: deps.accountStoragePath,
        statePath: deps.accountStatePath,
      })
      return {
        accountKey,
        label: 'Main account',
        accessToken: auth.access,
        chatgptAccountId: liveAccountId ?? freshStorage?.mainAccountId,
      }
    }

    const storage = await deps.loadAccounts({
      configPath: deps.accountStoragePath,
      statePath: deps.accountStatePath,
    })
    const account = storage?.accounts.find(
      (candidate) => candidate.id === accountKey,
    )
    if (!storage || !account) {
      throw new ResetTargetResolutionError(
        'unknown_account',
        `Fallback account ${accountKey} was not found.`,
      )
    }
    if (account.enabled === false) {
      throw new ResetTargetResolutionError(
        'disabled_account',
        `Fallback account ${accountKey} is disabled.`,
      )
    }
    if (!isOAuthAccount(account)) {
      throw new ResetTargetResolutionError(
        'non_oauth_account',
        `Fallback account ${accountKey} is not an OAuth account.`,
      )
    }

    const noToken = () =>
      new ResetTargetResolutionError(
        'token_unavailable',
        `Fallback account ${accountKey} has no usable access token.`,
      )
    if (isTombstoned(account)) throw noToken()
    let resolved = account
    if (
      resetTargetNeedsRefresh(
        resolved.access,
        resolved.expires,
        storage,
        deps.now(),
      )
    ) {
      resolved = await deps.refreshFallbackAccount(resolved, storage)
    }
    if (!resolved.access) throw noToken()

    const freshStorage = await deps.loadAccounts({
      configPath: deps.accountStoragePath,
      statePath: deps.accountStatePath,
    })
    const freshAccount = freshStorage?.accounts.find(
      (candidate) => candidate.id === accountKey,
    )
    if (!freshStorage || !freshAccount) {
      throw new ResetTargetResolutionError(
        'unknown_account',
        `Fallback account ${accountKey} was not found.`,
      )
    }
    if (freshAccount.enabled === false) {
      throw new ResetTargetResolutionError(
        'disabled_account',
        `Fallback account ${accountKey} is disabled.`,
      )
    }
    if (!isOAuthAccount(freshAccount)) {
      throw new ResetTargetResolutionError(
        'non_oauth_account',
        `Fallback account ${accountKey} is not an OAuth account.`,
      )
    }
    return {
      accountKey,
      label: resolved.label ?? accountKey,
      accessToken: resolved.access,
      chatgptAccountId: freshAccount.accountId,
    }
  }
}

export function buildResetRedemptionDeps() {
  return {
    fetchImpl: fetch,
    now: Date.now,
    randomUUID: () => crypto.randomUUID(),
  }
}

function isAuthPersistError(error: unknown): error is AuthPersistError {
  return error instanceof AuthPersistError
}

function cleanAbort(): never {
  throw new Error(HANDLED_SENTINEL)
}

/**
 * One write of the top-level settings the loader keeps (the main account's
 * ChatGPT identity, the main-refresh lease and its backoff). On a migrated
 * install it goes through the pool store's `updateSettings`, which writes
 * neither the roster nor the state file; before the migration it is the
 * legacy store's locked read-modify-write, as it always was.
 *
 * `holdsMainRefreshLock`: the caller already holds `main-refresh`, the lock a
 * settings write otherwise takes alongside the store's own.
 */
async function writeLoaderSettings(
  edit: (current: AccountStorage) => void,
  options: { holdsMainRefreshLock?: boolean } = {},
): Promise<void> {
  const paths = getAccountPaths(getConfigPath())
  if (poolMigrated(paths.configPath)) {
    await writeSettings(
      openAccountPool(paths),
      options.holdsMainRefreshLock ? undefined : poolSettingsLocks(paths),
      (settings) => edit(settings as unknown as AccountStorage),
    )
    return
  }
  await mutateAccounts((current) => {
    edit(current)
    return current
  }, paths)
}

/** The `/openai` context the latest loader run built, for tests. */
let menuContextForTest: OpenCodeMenuContext | null = null

/**
 * Test seam: the context the latest loader run gave the `/openai` menu, so a
 * test of the loader's live gates (keep-warm, sticky pins) can drive them on
 * an install the menu itself would not open on.
 */
export function __menuContextForTest(): OpenCodeMenuContext | null {
  return menuContextForTest
}

function jitterMs(baseMs: number) {
  return Math.floor(Math.random() * baseMs)
}

export {
  extractAccountIdFromClaims,
  type IdTokenClaims,
  parseJwtClaims,
} from '@cortexkit/openai-auth-core/internal'

// Moves the main login from OpenCode's slot into the account pool. The version
// fence holds the move until every running OpenCode process with this plugin
// runs a version that understands the pool, so an older process never sees a
// placeholder it would send. Going back to a version without pool support
// after the move leaves main unusable there. Kept as a constant so tests and
// the OpenCode 2 entry share one switch.
export const POOL_MIGRATION_ENABLED = true

interface CodexAuthPluginOptions {
  /**
   * Test seams for the background account-pool migration and adoption
   * (`core/pool-lifecycle.ts`): its fence, timers, run functions and
   * per-run dependencies.
   */
  poolMigration?: Partial<
    Pick<
      PoolLifecycleDeps,
      'fence' | 'migrate' | 'adopt' | 'timers' | 'random' | 'runDeps' | 'log'
    >
  > & {
    /** Overrides POOL_MIGRATION_ENABLED, so tests can run the migration. */
    enabled?: boolean
  }
  /** Test seam: timer functions for the background quota poller, so a test can fire its tick. */
  backgroundQuota?: ConstructorParameters<typeof BackgroundQuotaRefresh>[0]
  issuer?: string
  codexApiEndpoint?: string
  experimentalWebSockets?: boolean
  responsesLite?: boolean
  /**
   * Test seams for the Claustrum vault: its connections and the directory its
   * token and roster live in.
   */
  vault?: Partial<
    Pick<
      ConstructorParameters<typeof OpenAiVault>[0],
      | 'stateDir'
      | 'connectionFile'
      | 'connectScoped'
      | 'connectEnrollment'
      | 'pollIntervalMs'
    >
  > & {
    /**
     * Longest an adoption or the pool source's first quota polls wait for
     * the vault's first roster; `VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS` by
     * default.
     */
    firstRosterWaitMs?: number
  }
  /** Test seams for the OAuth logins of the auth methods. */
  login?: {
    /** Controls the wait for the host's slot write without real timers. */
    sleep?: (ms: number) => Promise<void>
    /** Replaces external OAuth I/O while preserving the hook callback. */
    authorize?: {
      browser?: () => Promise<{
        url: string
        tokens: Promise<TokenResponse>
        cleanup?: () => void
      }>
      headless?: () => Promise<{
        url: string
        instructions: string
        tokens: Promise<TokenResponse>
      }>
    }
  }
}

interface CodexSessionMetadata {
  threadID: string
  turnID: string
  windowID: string
  turnStartedAt?: number
  input?: unknown[]
  /**
   * The `reasoning.effort` this session opened with. Held so a later change can
   * be carried as a `configuration_update` item instead of as a different
   * request-level value. See `applyMidConversationEffort`.
   */
  pinnedEffort?: string
  effortUpdates?: Array<{ anchor: number; fingerprint: string; effort: string }>
}

interface PersistedCodexSessions {
  version?: number
  sessions?: Record<string, { threadID?: unknown }>
}

interface PreparedCodexRequest {
  init: RequestInit | undefined
}

function parseJsonObject(input: unknown) {
  if (typeof input !== 'string') return undefined
  try {
    const parsed = JSON.parse(input)
    return typeof parsed === 'object' &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

// Real Codex mints the session/thread id (which becomes prompt_cache_key,
// session-id, thread-id, x-client-request-id, window_id) as a UUIDv7 — a
// time-ordered id whose first 48 bits are the unix-ms timestamp. crypto.randomUUID()
// only produces UUIDv4 (uniform random). OpenAI's prompt_cache_key is a routing
// hint; matching Codex's v7 shape exactly removes the only remaining wire-level
// difference from the Codex client when probing prompt-cache routing behavior.
function getCodexSessionMetadata(
  sessions: Map<string, CodexSessionMetadata>,
  sessionID: string,
  persist?: () => void,
): CodexSessionMetadata {
  const existing = sessions.get(sessionID)
  if (existing) return existing
  const threadID = uuidV7()
  const next: CodexSessionMetadata = {
    threadID,
    turnID: uuidV7(),
    windowID: `${threadID}:0`,
  }
  sessions.set(sessionID, next)
  persist?.()
  return next
}

function codexSessionStatePath() {
  return join(getConfigDir(), 'openai-auth-sessions.json')
}

function loadCodexSessions(): Map<string, CodexSessionMetadata> {
  const sessions = new Map<string, CodexSessionMetadata>()
  try {
    const parsed = JSON.parse(
      readFileSync(codexSessionStatePath(), 'utf8'),
    ) as PersistedCodexSessions
    if (!isRecord(parsed.sessions)) return sessions
    for (const [sessionID, state] of Object.entries(parsed.sessions)) {
      if (!isRecord(state) || typeof state.threadID !== 'string') continue
      sessions.set(sessionID, {
        threadID: state.threadID,
        turnID: uuidV7(),
        windowID: `${state.threadID}:0`,
      })
    }
  } catch {
    // Missing or malformed state should not break auth.
  }
  return sessions
}

function saveCodexSessions(sessions: Map<string, CodexSessionMetadata>): void {
  const path = codexSessionStatePath()
  const tmp = `${path}.tmp-${process.pid}`
  try {
    mkdirSync(getConfigDir(), { recursive: true })
    const payload: PersistedCodexSessions = {
      version: 1,
      sessions: Object.fromEntries(
        [...sessions.entries()].map(([sessionID, state]) => [
          sessionID,
          { threadID: state.threadID },
        ]),
      ),
    }
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch {
    // State persistence only improves cache continuity; never fail a request.
  }
}

function isMessageWithRole(item: unknown, role: string) {
  return (
    isRecord(item) &&
    (item.type === 'message' || 'role' in item) &&
    item.role === role
  )
}

function hasInputPrefix(prefix: unknown[], input: unknown[]) {
  if (prefix.length > input.length) return false
  for (let index = 0; index < prefix.length; index++) {
    if (stableStringify(prefix[index]) !== stableStringify(input[index]))
      return false
  }
  return true
}

function startsHttpUserTurn(metadata: CodexSessionMetadata, input: unknown[]) {
  if (!metadata.input) return input.length > 0
  if (!hasInputPrefix(metadata.input, input)) return true
  const suffix = input.slice(metadata.input.length)
  return suffix.some(
    (item) =>
      isMessageWithRole(item, 'user') || isMessageWithRole(item, 'developer'),
  )
}

function updateHttpTurnMetadata(
  metadata: CodexSessionMetadata,
  body: Record<string, unknown> | undefined,
) {
  const input = Array.isArray(body?.input) ? body.input : undefined
  if (input && (startsHttpUserTurn(metadata, input) || !metadata.turnID)) {
    metadata.turnID = uuidV7()
    metadata.turnStartedAt = Date.now()
  } else if (!metadata.turnStartedAt) {
    metadata.turnStartedAt = Date.now()
  }
  // Copy the host input before effort updates are inserted, so the next tool
  // request compares against host history and does not start a false user turn.
  if (input) metadata.input = input.slice()
}

function prepareCodexRequest(input: {
  init: RequestInit | undefined
  headers: Headers
  metadata: CodexSessionMetadata | undefined
  installationID: string
  websocket: boolean
  responsesLite: boolean
  dumpSessionID?: string
}): PreparedCodexRequest {
  // Read and remove the internal agent header before any early return, so it
  // cannot reach outgoing headers, cachekeep captures or request dumps.
  const agent = input.headers.get(OPENAI_AGENT_HEADER)
  input.headers.delete(OPENAI_AGENT_HEADER)
  if (!input.metadata) return { init: input.init }
  const body = parseJsonObject(input.init?.body)
  if (!input.websocket) updateHttpTurnMetadata(input.metadata, body)
  else if (!input.metadata.turnStartedAt)
    input.metadata.turnStartedAt = Date.now()
  if (!input.metadata.turnStartedAt) input.metadata.turnStartedAt = Date.now()
  // Base turn-metadata. HTTP sends full replay bodies, so we detect fresh user turns from append-only
  // input growth above. The WebSocket path still overrides turn_id/turn_started_at in ws-pool.ts
  // after continuation trimming/prewarm selection.
  // Codex turn-metadata schema (exact field set + order; no request_id/originator):
  // { session_id, thread_id, thread_source, turn_id, sandbox, turn_started_at_unix_ms, request_kind, window_id }
  const turnMetadata = JSON.stringify({
    session_id: input.metadata.threadID,
    thread_id: input.metadata.threadID,
    thread_source: 'user',
    turn_id: input.metadata.turnID,
    sandbox: CODEX_SANDBOX,
    turn_started_at_unix_ms: input.metadata.turnStartedAt,
    request_kind: 'turn',
    window_id: input.metadata.windowID,
  })
  input.headers.set('originator', 'codex_exec')
  if (input.websocket) {
    // Codex's WebSocket upgrade carries neither Accept nor Content-Type.
    input.headers.delete('accept')
    input.headers.delete('content-type')
  } else {
    input.headers.set('accept', 'text/event-stream')
  }
  input.headers.set('session-id', input.metadata.threadID)
  input.headers.delete('x-session-id')
  input.headers.delete('x-session-affinity')
  input.headers.set('thread-id', input.metadata.threadID)
  input.headers.set('x-codex-window-id', input.metadata.windowID)
  // Codex uses the session/thread UUID as x-client-request-id (not a fresh per-request id).
  input.headers.set('x-client-request-id', input.metadata.threadID)
  input.headers.set('x-codex-beta-features', CODEX_BETA_FEATURES)
  input.headers.set('x-codex-turn-metadata', turnMetadata)
  input.headers.set('user-agent', CODEX_USER_AGENT)
  input.headers.set('version', CODEX_VERSION)
  if (input.dumpSessionID)
    input.headers.set(DUMP_SESSION_HEADER, input.dumpSessionID)

  const parsed = body
  if (!parsed) return { init: input.init }
  const useResponsesLite =
    input.responsesLite &&
    typeof parsed.model === 'string' &&
    RESPONSES_LITE_MODELS.has(parsed.model)
  if (useResponsesLite && !input.websocket)
    input.headers.set('x-openai-internal-codex-responses-lite', 'true')
  parsed.prompt_cache_key = input.metadata.threadID
  parsed.parallel_tool_calls ??= true
  if (Array.isArray(parsed.tools))
    parsed.tools = parsed.tools.map(normalizeCodexTool)
  applyMidConversationEffort(parsed, input.metadata, agent)
  if (useResponsesLite) rewriteResponsesLiteBody(parsed)
  const clientMetadata: Record<string, unknown> = {
    ...(typeof parsed.client_metadata === 'object' &&
    parsed.client_metadata !== null
      ? parsed.client_metadata
      : {}),
    'x-codex-installation-id': input.installationID,
    'x-codex-window-id': input.metadata.windowID,
  }
  if (input.websocket) {
    clientMetadata['x-codex-turn-metadata'] = turnMetadata
    clientMetadata['x-codex-ws-stream-request-start-ms'] = String(Date.now())
    if (useResponsesLite)
      clientMetadata.ws_request_header_x_openai_internal_codex_responses_lite =
        'true'
  }
  parsed.client_metadata = clientMetadata
  input.headers.delete('content-length')
  input.headers.delete('Content-Length')
  return {
    init: { ...input.init, body: JSON.stringify(orderCodexBody(parsed)) },
  }
}

export function findCachekeepFallbackAccount(
  accounts: FallbackAccount[],
  accountId: string,
): OAuthAccount | undefined {
  return accounts.find(
    (a): a is OAuthAccount =>
      a.enabled !== false &&
      isOAuthAccount(a) &&
      (a.id === accountId || a.accountId === accountId),
  )
}

// wham is the only source that reports reset-credit counts and spend-control
// budgets; header/WS pushes never carry those fields. An incoming push that
// omits them inherits the last known reading for the same account so the
// sidebar and command output do not lose it on every per-turn update — but an
// explicit incoming value (including 0) always wins over a stale cached one.
export function mergePushedQuotaMetadata(
  incoming: OAuthQuotaSnapshot,
  previous: OAuthQuotaSnapshot | undefined,
): OAuthQuotaSnapshot {
  if (!previous) return incoming
  const merged: OAuthQuotaSnapshot = { ...incoming }
  for (const key of [
    'resetCreditsAvailable',
    'resetCreditsApplicable',
  ] as const) {
    const carried = previous[key]
    if (merged[key] === undefined && carried !== undefined) {
      merged[key] = carried
    }
  }
  // A snapshot that explicitly reports no budget must not inherit the old one.
  if (
    merged.spendControl === undefined &&
    merged.spendControlCleared !== true &&
    previous.spendControl !== undefined
  ) {
    merged.spendControl = previous.spendControl
  }
  return merged
}

// Returns the window unchanged when it already carries a usable checkedAt, or
// the same window with the entry timestamp stamped onto it when it does not.
// Absent windows are returned unchanged so we never fabricate a slot the wire
// did not report. The stamp keeps mergeQuotaByWindow's per-window freshness
// comparison meaningful against files written without window stamps (old code
// only wrote the snapshot-level checkedAt).
function stampWindowCheckedAt(
  window: QuotaWindow | undefined,
  entryCheckedAt: number,
): QuotaWindow | undefined {
  if (!window) return window
  if (
    typeof window.checkedAt === 'number' &&
    Number.isFinite(window.checkedAt)
  ) {
    return window
  }
  return { ...window, checkedAt: entryCheckedAt }
}

export function buildSidebarMachineState(
  qm: QuotaManager,
  store: AccountStorage,
  now = Date.now(),
  mainAccountIdentity = store.mainAccountId,
): SidebarMachineState {
  const mainEntry = qm.getMain()
  const mainQuota = mainEntry?.quota
  return {
    main: {
      quota: mainQuota
        ? {
            ...(mainQuota as AccountQuota),
            checkedAt: mainEntry.checkedAt,
            primary: stampWindowCheckedAt(
              mainQuota.primary,
              mainEntry.checkedAt,
            ),
            secondary: stampWindowCheckedAt(
              mainQuota.secondary,
              mainEntry.checkedAt,
            ),
          }
        : null,
      ...(typeof mainAccountIdentity === 'string'
        ? { mainAccountId: mainAccountIdentity }
        : {}),
      killed: false,
      ...(mainQuota?.resetCreditsAvailable !== undefined
        ? { resetCredits: mainQuota.resetCreditsAvailable }
        : {}),
    },
    fallbacks: store.accounts
      .filter((account) => account.enabled)
      .map((account) => {
        const fallbackEntry = qm.getFallback(account.id)
        const fallbackQuota = fallbackEntry?.quota
        return {
          id: account.id,
          label: (account as { label?: string }).label,
          // Identity follows the cached snapshot (the identity that quota was
          // captured under), falling back to the live account — so a re-login
          // never pairs the previous identity's stale quota with the new one.
          accountId:
            fallbackEntry?.accountId ?? (account as OAuthAccount).accountId,
          quota: fallbackQuota
            ? {
                ...(fallbackQuota as AccountQuota),
                checkedAt: fallbackEntry.checkedAt,
                primary: stampWindowCheckedAt(
                  fallbackQuota.primary,
                  fallbackEntry.checkedAt,
                ),
                secondary: stampWindowCheckedAt(
                  fallbackQuota.secondary,
                  fallbackEntry.checkedAt,
                ),
              }
            : null,
          killed: false,
          enabled: true,
          ...(fallbackQuota?.resetCreditsAvailable !== undefined
            ? { resetCredits: fallbackQuota.resetCreditsAvailable }
            : {}),
        }
      }),
    route: store.routing?.mode ?? 'main-first',
    lastUpdated: now,
  }
}

export function buildSidebarState(
  qm: QuotaManager,
  store: AccountStorage,
  activeId: string,
  now = Date.now(),
): SidebarState {
  return { ...buildSidebarMachineState(qm, store, now), activeId }
}

function effectiveRequestHeaders(
  requestInput: RequestInfo | URL,
  init: RequestInit | undefined,
): Headers {
  if (init?.headers !== undefined) return new Headers(init.headers)
  if (requestInput instanceof Request) return new Headers(requestInput.headers)
  return new Headers()
}

async function materializeRequestInit(
  requestInput: RequestInfo | URL,
  init: RequestInit | undefined,
): Promise<RequestInit | undefined> {
  if (!(requestInput instanceof Request)) return init
  const request = new Request(requestInput, init)
  const method = request.method.toUpperCase()
  const body =
    method === 'GET' || method === 'HEAD' || request.body === null
      ? undefined
      : await request.text()
  return {
    method: request.method,
    headers: new Headers(request.headers),
    body,
    signal: request.signal,
    cache: request.cache,
    credentials: request.credentials,
    integrity: request.integrity,
    keepalive: request.keepalive,
    mode: request.mode,
    redirect: request.redirect,
    referrer: request.referrer,
    referrerPolicy: request.referrerPolicy,
  }
}

export function resolveSidebarSessionId(headers: Headers): string | undefined {
  return (
    headers.get('x-session-affinity') ??
    headers.get('x-opencode-session') ??
    headers.get('x-session-id') ??
    headers.get('session-id') ??
    undefined
  )
}
function stripResponsesLiteImageDetails(value: unknown) {
  if (Array.isArray(value)) {
    for (const item of value) stripResponsesLiteImageDetails(item)
    return
  }
  if (!isRecord(value)) return
  if (value.type === 'input_image') delete value.detail
  for (const nested of Object.values(value))
    stripResponsesLiteImageDetails(nested)
}

// Models where a `configuration_update` item is both accepted and shown to change
// effort. Accepted is not enough: a silently ignored item also completes with 200,
// so each entry was measured by reasoning tokens on one hard prompt at low effort,
// without and with an update to xhigh:
//   gpt-6-sol    91 -> 516
//   gpt-6-luna   1034 -> 3126
//   gpt-6.1-sol  878, 938 -> 1227, 1247 (two samples each; a request-level
//                xhigh on the same prompt gave 733 and 1456)
// gpt-5.6-sol is deliberately NOT here. It answered 400 for this item until
// September 2026, now accepts it, and moved 2292 -> 3785 on a single sample -
// too weak to tell from noise, on a model people already run, where the
// request-level effort change it uses today is known to work.
export const MID_CONVERSATION_EFFORT_MODELS: ReadonlySet<string> = new Set([
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6.1-sol',
])

// OpenCode's built-in definitions (packages/opencode/src/agent/agent.ts in the
// OpenCode repository) mark title, compaction and summary as hidden helpers,
// not the conversation's agent loop. chat.headers supplies the
// host's agent name; missing tags retain compatibility with other fetch callers.
const OPENAI_AGENT_HEADER = 'x-openai-auth-agent'
const HIDDEN_EFFORT_AGENTS = new Set(['title', 'compaction', 'summary'])

/**
 * Keep the request-level effort fixed for prefix caching. The host does not
 * replay injected items, so remember each change at its original user message
 * and rebuild the same prefix before the WebSocket pool trims continuations.
 * Fingerprints detect compaction/revert at an anchor; a rewritten conversation
 * starts a new pin rather than replaying instructions into unrelated history.
 * Usage still reports the pinned request-level effort, not the effective one.
 */
function applyMidConversationEffort(
  parsed: Record<string, unknown>,
  metadata: CodexSessionMetadata,
  agent: string | null,
) {
  if (agent !== null && HIDDEN_EFFORT_AGENTS.has(agent)) return
  const model = typeof parsed.model === 'string' ? parsed.model : ''
  if (!MID_CONVERSATION_EFFORT_MODELS.has(model)) return
  const reasoning = isRecord(parsed.reasoning) ? parsed.reasoning : undefined
  const effort =
    typeof reasoning?.effort === 'string' ? reasoning.effort : undefined
  if (!effort) return
  const input = Array.isArray(parsed.input) ? parsed.input : undefined
  metadata.effortUpdates ??= []
  const updates = metadata.effortUpdates
  const fingerprint = (item: unknown) =>
    createHash('sha256')
      .update(stableStringify(item))
      .digest('hex')
      .slice(0, 16)
  if (
    metadata.pinnedEffort === undefined ||
    updates.some(
      (update) =>
        !input ||
        !isMessageWithRole(input[update.anchor], 'user') ||
        fingerprint(input[update.anchor]) !== update.fingerprint,
    )
  ) {
    metadata.pinnedEffort = effort
    metadata.effortUpdates = []
    return
  }
  if (!input || input.length === 0) return
  const anchor = input.findLastIndex((item) => isMessageWithRole(item, 'user'))
  const latest = updates.at(-1)
  const effective = latest?.effort ?? metadata.pinnedEffort
  if (anchor >= 0 && effort !== effective) {
    if (latest?.anchor === anchor) {
      const before = updates.at(-2)?.effort ?? metadata.pinnedEffort
      if (effort === before) updates.pop()
      else latest.effort = effort
    } else {
      updates.push({ anchor, fingerprint: fingerprint(input[anchor]), effort })
    }
  } else if (anchor < 0 && effort !== effective) {
    // No user turn can carry a new instruction; leave the host's effort alone.
    return
  }
  // Anchors only ever grow, because a new one is the latest user message and
  // an older anchor that moved fails its fingerprint first. Should that ever
  // not hold, start over from this request's effort rather than fail the
  // request or send two updates side by side, which the API refuses.
  if (
    updates.some(
      (update, i) => i > 0 && update.anchor <= (updates[i - 1]?.anchor ?? -1),
    )
  ) {
    metadata.pinnedEffort = effort
    metadata.effortUpdates = []
    return
  }
  parsed.reasoning = { ...reasoning, effort: metadata.pinnedEffort }
  // Anchors are indices into the host's input. Inserting from the highest
  // anchor down keeps the lower ones valid. Each update goes in front of a
  // different user message, so that message always separates it from the
  // next update: the API refuses two updates side by side.
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i]
    if (!update) continue
    input.splice(update.anchor, 0, {
      type: 'configuration_update',
      reasoning: { effort: update.effort },
    })
  }
}

// Responses Lite trades capabilities for Codex's compact request shape. It is
// opt-in because it disables parallel tool calls and excludes hosted tools.
export function rewriteResponsesLiteBody(parsed: Record<string, unknown>) {
  const reasoning = isRecord(parsed.reasoning) ? { ...parsed.reasoning } : {}
  reasoning.context = 'all_turns'
  parsed.reasoning = reasoning
  parsed.parallel_tool_calls = false

  const input = Array.isArray(parsed.input) ? parsed.input : []
  stripResponsesLiteImageDetails(input)
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.filter(
        (tool) => !(isRecord(tool) && tool.type === 'web_search'),
      )
    : []
  const prefix: unknown[] = [
    { type: 'additional_tools', role: 'developer', tools },
  ]
  if (
    typeof parsed.instructions === 'string' &&
    parsed.instructions.length > 0
  ) {
    prefix.push({
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: parsed.instructions }],
    })
  }
  parsed.input = [...prefix, ...input]
  delete parsed.tools
  delete parsed.instructions
}

// Match Codex's function-tool shape: drop the JSON-Schema `$schema` dialect marker
// (Codex omits it) and mark function tools `strict: false` as Codex does.
function normalizeCodexTool(tool: unknown) {
  if (!isRecord(tool)) return tool
  if (tool.type !== 'function') return tool
  const parameters =
    isRecord(tool.parameters) && '$schema' in tool.parameters
      ? (() => {
          const { $schema: _schema, ...rest } = tool.parameters as Record<
            string,
            unknown
          >
          return rest
        })()
      : tool.parameters
  // Codex function-tool key order: type, name, description, strict, parameters (+ any extras).
  const { type, name, description, strict, parameters: _p, ...extra } = tool
  return {
    type,
    name,
    description,
    strict: strict ?? false,
    parameters,
    ...extra,
  }
}

export async function CodexAuthPlugin(
  input: PluginInput,
  options: CodexAuthPluginOptions = {},
): Promise<Hooks> {
  const codexApiEndpoint =
    options.codexApiEndpoint ?? getSettings().codexApiEndpoint
  const installationID = crypto.randomUUID()
  const codexSessions = loadCodexSessions()
  const persistCodexSessions = () => saveCodexSessions(codexSessions)
  let websocketFetchInstalled = false
  let codexFetchInstalled = false
  const websocketFetches: Array<
    ReturnType<typeof OpenAIWebSocketPool.createWebSocketFetch>
  > = []

  // Command context holder — filled by the auth loader on first run.
  // command.execute.before reads this; if null (auth not loaded yet),
  // the command is rejected with a message.
  let cmdCtx: OpenCodeMenuContext | null = null
  // OpenCode's `openai` login slot, for the account-pool migration, the
  // adoption of later logins and the wait for a login's write. OpenCode 1's
  // plugin client can write the slot but not read it, so it is read from
  // OpenCode's `auth.json` (`core/host-slot.ts`).
  const hostSlot = opencode1SlotForClient(input.client)
  const ownedCacheKeepManagers = new Map<string, OpenAICacheKeepManager>()
  const ownedRpcServers = new Map<string, RpcServerAdoption>()
  let activeFallbackManager: FallbackAccountManager | undefined
  let missingPoolMainLogged = false
  let sidebarStateFileForEvents: string | undefined
  // Sticky-balanced session-to-account pins this process placed and is using,
  // whose writes may not have reached the sidebar file yet (see
  // StickyPinOverlayEntry). Kept here rather than in the loader so session
  // deletion and dispose can reach them.
  const stickyPinOverlay: StickyPinOverlay = new Map()
  let stickyPinOverlayFile: string | undefined
  // Background writer for the sidebar updates requests make (routing display,
  // pushed quota, sticky pins); the loader installs one per run.
  let sidebarBookkeeping: SidebarBookkeepingQueue | undefined
  // The vault state belongs to the host, not the project, so every project
  // this process loads shares one vault consumer (`core/shared-vault.ts`).
  // This instance holds a reference and releases it on dispose; the consumer
  // closes when the last project releases. All of them route over the same
  // pool store, the one `getConfigPath()` names for this process.
  const vaultLease = acquireOpenCodeVault(
    {
      host: 'opencode',
      stateDir:
        options.vault?.stateDir ??
        vaultStateDir(getAccountPaths(getConfigPath()).statePath),
      ...(input.directory ? { projectRoot: input.directory } : {}),
      reservedRouteIds: () =>
        poolAccountSource?.peek().rows.map((row) => row.id) ?? [],
      ...(options.vault?.connectionFile
        ? { connectionFile: options.vault.connectionFile }
        : {}),
      ...(options.vault?.connectScoped
        ? { connectScoped: options.vault.connectScoped }
        : {}),
      ...(options.vault?.connectEnrollment
        ? { connectEnrollment: options.vault.connectEnrollment }
        : {}),
      ...(options.vault?.pollIntervalMs !== undefined
        ? { pollIntervalMs: options.vault.pollIntervalMs }
        : {}),
      fetchImpl: () => fetch,
    },
    getAccountPaths(getConfigPath()),
  )
  const vault = vaultLease.vault
  // Until the vault's first account list arrives, a local pool row signed in
  // as an account the vault holds looks like this host's own and could be
  // served or adopted twice. Login adoption and first-sight quota polls wait
  // for that shared first read (bounded); plugin setup and the loader never
  // do, so OpenCode's startup does not depend on the vault.
  const vaultFirstRoster = vaultLease.firstRoster
  const vaultNotUsed = Promise.withResolvers<void>()
  const vaultReadyForAdoption = Promise.race([
    vaultFirstRoster,
    vaultNotUsed.promise,
  ])
  const vaultRosterWaitMs =
    options.vault?.firstRosterWaitMs ?? VAULT_FIRST_ROSTER_BACKGROUND_WAIT_MS
  // This instance's entry in the per-process heartbeat directory, written by
  // the first loader run and dropped on dispose.
  let processHeartbeat: Promise<ProcessHeartbeatHandle> | undefined
  // The account pool as the request path's source of accounts once the
  // install is migrated; the loader installs one per run.
  let poolAccountSource: PoolAccountSource | undefined
  // Background account-pool migration, and adoption into the pool of logins
  // that land in OpenCode's slot after it. A client that cannot write the
  // slot runs without both and logs why: a migration that is off without a
  // word is indistinguishable from one that ran.
  const { enabled: poolMigrationEnabled, ...poolMigrationDeps } =
    options.poolMigration ?? {}
  const poolMigrationOn = poolMigrationEnabled ?? POOL_MIGRATION_ENABLED
  if (poolMigrationOn && 'reason' in hostSlot)
    (poolMigrationDeps.log ?? createLogger('pool')).warn(
      'account pool migration is off for this OpenCode client',
      { reason: hostSlot.reason },
    )
  const poolLifecycle: PoolLifecycle | undefined =
    poolMigrationOn && 'slot' in hostSlot
      ? createPoolLifecycle({
          paths: () => getAccountPaths(getConfigPath()),
          slot: hostSlot.slot,
          version: PackageVersion,
          ...poolMigrationDeps,
          // While the vault serves this host its accounts, a login in the slot
          // is not adopted (the request path refuses it instead).
          runDeps: {
            vaultServes: () => vault.serves(),
            ...poolMigrationDeps.runDeps,
          },
          // After a migration or an adoption run the pool may hold a row this
          // process has never polled (or the install just turned migrated).
          // Re-reading it now starts those first quota polls at once, so an
          // account is not refused for unknown quota until a request happens
          // to notice the change. Never awaited by the run.
          migrate: async (deps) => {
            const outcome = await (poolMigrationDeps.migrate ?? migrateToPool)(
              deps,
            )
            void poolAccountSource?.load()
            return outcome
          },
          // Until the vault's first roster read has settled, `vaultServes` is
          // false even on a host the vault serves, so an adoption waits for
          // it. Only this background run waits, never the loader, and only
          // for a bounded time: past it the run adopts nothing and ends
          // retryable, so the lifecycle stays free and tries again later.
          adopt: async (deps) => {
            if (
              !(await settlesWithin(vaultReadyForAdoption, vaultRosterWaitMs))
            )
              return { status: 'retry', reason: 'vault-roster-pending' }
            const outcome = await (
              poolMigrationDeps.adopt ?? adoptHostSlotLogin
            )(deps)
            void poolAccountSource?.load()
            return outcome
          },
        })
      : undefined
  /** A test's OAuth flow, in the result shape OpenCode's auth hook expects. */
  const authorizeWith = (
    start:
      | (() => Promise<{
          url: string
          instructions?: string
          tokens: Promise<TokenResponse>
          cleanup?: () => void
        }>)
      | undefined,
    instructions = '',
  ) =>
    start
      ? async (): Promise<AuthOAuthResult> => {
          const flow = await start()
          return {
            url: flow.url,
            instructions: flow.instructions ?? instructions,
            method: 'auto',
            callback: async () => {
              try {
                const tokens = await flow.tokens
                return {
                  type: 'success',
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                  accountId: extractAccountId(tokens),
                }
              } finally {
                flow.cleanup?.()
              }
            },
          }
        }
      : undefined

  // Per-loader poller: each plugin invocation owns its timer and callback, so
  // one loader disposing or re-starting never stops or overwrites another's
  // background refresh (a module-level singleton let the last loader win and
  // let any disposal kill the shared poller).
  const backgroundQuotaRefresh = new BackgroundQuotaRefresh(
    options.backgroundQuota,
  )

  let loaderGetAuth:
    | Parameters<NonNullable<NonNullable<Hooks['auth']>['loader']>>[0]
    | undefined
  const authMethods = createAuthMethods({
    client: input.client,
    getAuth: async () => loaderGetAuth?.(),
    fetchImpl: fetch,
    dependencies: {
      ...(options.login?.authorize
        ? {
            authorizeBrowser: authorizeWith(
              options.login.authorize.browser,
              'Complete authorization in your browser. This window will close automatically.',
            ),
            authorizeHeadless: authorizeWith(options.login.authorize.headless),
          }
        : {}),
    },
    vault,
    onMainSlotWritten: async () => {
      await poolLifecycle?.requestAdoption()
    },
  })
  /**
   * After a successful login through these methods OpenCode writes the
   * credential into its own slot. Once it is there, a migrated install moves
   * it into the account pool; the write is watched for (for five seconds)
   * rather than left for the next adoption tick.
   */
  const adoptAfterHostWrite =
    (
      authorize: (inputs?: Record<string, string>) => Promise<AuthOAuthResult>,
    ) =>
    async (inputs?: Record<string, string>): Promise<AuthOAuthResult> => {
      const flow = await authorize(inputs)
      if (flow.method !== 'auto') return flow
      return {
        ...flow,
        callback: async () => {
          const result = await flow.callback()
          if (result.type === 'success' && 'refresh' in result)
            void watchHostWrite(result.refresh)
          return result
        },
      }
    }
  async function watchHostWrite(refresh: string): Promise<void> {
    if (!poolLifecycle || !('slot' in hostSlot)) return
    const sleep = options.login?.sleep ?? ((ms: number) => Bun.sleep(ms))
    for (let waited = 0; waited < 5_000; waited += 100) {
      try {
        const auth = await hostSlot.slot.get({ path: { id: 'openai' } })
        if (isRecord(auth) && auth.refresh === refresh) {
          await poolLifecycle.requestAdoption()
          return
        }
      } catch {
        // A failed read of the slot is tried again until the deadline.
      }
      await sleep(100)
    }
  }
  const loginAuthMethods = authMethods.map((method) =>
    method.type === 'oauth'
      ? { ...method, authorize: adoptAfterHostWrite(method.authorize) }
      : method,
  )

  async function sendIgnoredMessage(sessionId: string, text: string) {
    const session = input.client.session as
      | { promptAsync?: (req: unknown) => Promise<unknown> }
      | undefined
    if (typeof session?.promptAsync === 'function') {
      // OpenCode records this hidden noReply message as a user message. Without
      // the previous model/variant, its next real prompt inherits the synthetic
      // default and can silently drop a selected reasoning variant. Thread the
      // last assistant's model/agent/variant so the user's selection is kept.
      const promptContext = await resolvePromptContext(input.client, sessionId)
      const body: Record<string, unknown> = {
        noReply: true,
        parts: [{ type: 'text', text, ignored: true }],
      }
      if (promptContext?.agent) body.agent = promptContext.agent
      if (promptContext?.model) body.model = promptContext.model
      if (promptContext?.variant) body.variant = promptContext.variant
      await session.promptAsync({ path: { id: sessionId }, body })
      return
    }
    // Fallback: log it. The user won't see the dialog if TUI is not running.
  }

  return {
    async dispose() {
      vaultLease.release()
      poolLifecycle?.dispose()
      poolAccountSource?.dispose()
      backgroundQuotaRefresh.stop()
      sidebarBookkeeping?.stop()
      activeFallbackManager?.stopBackgroundRefresh()
      activeFallbackManager = undefined
      for (const websocketFetch of websocketFetches) websocketFetch.close()
      websocketFetches.length = 0
      const cacheKeepGlobal = globalThis as {
        __openaiAuthCacheKeepManagers?: Map<string, OpenAICacheKeepManager>
      }
      for (const [key, manager] of ownedCacheKeepManagers) {
        if (
          cacheKeepGlobal.__openaiAuthCacheKeepManagers?.get(key) === manager
        ) {
          manager.stop()
          cacheKeepGlobal.__openaiAuthCacheKeepManagers.delete(key)
        }
      }
      ownedCacheKeepManagers.clear()

      // Release stops a server only while it is still the registered one, so
      // a replaced instance cannot stop its successor's server.
      for (const adoption of ownedRpcServers.values()) {
        await adoption.release().catch(() => {})
      }
      ownedRpcServers.clear()

      const heartbeat = processHeartbeat
      processHeartbeat = undefined
      await (await heartbeat)?.release()
    },
    async event(input) {
      if (input.event.type !== 'session.deleted') return
      const info = input.event.properties.info
      const meta = codexSessions.get(info.id)
      if (meta) {
        cmdCtx?.cacheKeepManager?.remove(meta.threadID)
      }
      if (codexSessions.delete(info.id)) persistCodexSessions()
      // A pin still waiting to be written would otherwise land after the
      // removal below and resurrect the deleted session's entry.
      const deletedSessionHash = hashSidebarSessionId(info.id)
      stickyPinOverlay.delete(deletedSessionHash)
      sidebarBookkeeping?.cancel(`pin:${deletedSessionHash}`)
      if (sidebarStateFileForEvents) {
        const accounts = (await loadAccounts(getAccountPaths(getConfigPath())))
          ?.accounts
        await removeSidebarActiveRouting(
          info.id,
          accounts,
          sidebarStateFileForEvents,
        )
      }
      for (const websocketFetch of websocketFetches)
        websocketFetch.remove(info.id)
    },
    provider: {
      id: 'openai',
      async models(provider, ctx) {
        if (ctx.auth?.type !== 'oauth') return provider.models

        const storage = await loadAccounts(getAccountPaths(getConfigPath()))
        const zeroCosts = !storage || isCostZeroingEnabled(storage)
        const catalog = zeroCosts ? null : await loadModelsDevCosts()
        if (!zeroCosts && catalog && !loggedCostRestoration) {
          loggedCostRestoration = true
          logModels.debug('restoring OAuth model costs from models.dev catalog')
        }
        if (!zeroCosts && !catalog && !warnedCostCatalogUnavailable) {
          warnedCostCatalogUnavailable = true
          logModels.warn(
            'models.dev catalog unavailable; OAuth model costs could not be restored',
          )
        }

        return Object.fromEntries(
          Object.entries(provider.models)
            .filter(
              ([, model]) =>
                model.options.reasoningMode !== 'pro' &&
                codexOAuthModelListed(model.api.id),
            )
            .map(([modelID, model]) => [
              modelID,
              {
                ...model,
                cost: zeroCosts
                  ? { input: 0, output: 0, cache: { read: 0, write: 0 } }
                  : (catalog?.[model.api.id] ??
                    catalog?.[modelID] ??
                    model.cost),
                limit: codexOAuthModelLimit(model.id) ?? model.limit,
              },
            ]),
        )
      },
    },
    auth: {
      provider: 'openai',
      async loader(getAuth) {
        loaderGetAuth = getAuth
        processHeartbeat ??= startProcessHeartbeat({
          version: PackageVersion,
          logger: createLogger('heartbeat'),
        })
        await processHeartbeat
        // The account-pool migration waits for the heartbeat: it is how this
        // process shows up to another one's version fence. Never awaited
        // here, and it cannot throw.
        poolLifecycle?.start()
        const auth = await getAuth()
        if (auth.type !== 'oauth') {
          // No OAuth login, so this instance never starts the vault. Release
          // its own login-adoption wait; the shared first read stays pending
          // for the other projects that do use the vault.
          vaultNotUsed.resolve()
          return {}
        }

        // A tombstone the removed vault custody left in the slot is not a
        // credential: nothing is seeded or derived from it.
        const slotTombstoned = classifyMainAuthSlot(auth).kind === 'tombstone'
        // The vault polls in the background whether or not this host is
        // enrolled, so an enrollment finished in another process (`opencode
        // auth login`) is picked up without a restart. Nothing here waits for
        // its first roster read; `vaultFirstRoster` reports when it settles.
        vaultLease.start()
        const rpcDir = input.directory
          ? await resolveRpcDir(input.directory)
          : undefined
        const cacheKeepKey = rpcDir?.dir ?? getConfigPath()

        // Migration: seed the multi-account store from the existing token (idempotent)
        if (!slotTombstoned) {
          await migrateIfNeeded(
            {
              type: 'oauth',
              access: auth.access ?? '',
              refresh: auth.refresh ?? '',
              expires: auth.expires ?? 0,
            },
            getAccountPaths(getConfigPath()),
          )
        }

        // Construct managers for push-only quota updates from response headers.
        // Wrap the first boot-time read so a corrupt store surfaces a clear,
        // actionable message instead of a raw JSON.parse SyntaxError.
        const storage = await loadAccounts(
          getAccountPaths(getConfigPath()),
        ).catch((err) => {
          const path = getConfigPath()
          throw new Error(
            `OpenAI auth store at ${path} is corrupt or unreadable: ${err instanceof Error ? err.message : String(err)}. Fix or remove it to continue.`,
            { cause: err },
          )
        })

        if (
          await poolPlaceholderWithoutMain(
            getAccountPaths(getConfigPath()),
            auth,
          )
        ) {
          if (poolLifecycle) poolLifecycle.noticePlaceholderWithoutMain()
          else if (!missingPoolMainLogged) {
            missingPoolMainLogged = true
            createLogger('pool-migration').warn(POOL_LOGIN_REQUIRED_MESSAGE, {
              reason: 'placeholder-without-main',
            })
          }
        }

        let requestStorageCache:
          | {
              path: string
              mtimeMs: number
              size: number
              storage: Awaited<ReturnType<typeof loadAccounts>>
            }
          | undefined

        // The newest store snapshot this loader has read. It is the answer when
        // a request's read overruns its budget, and what background sidebar
        // writes describe, so neither has to read the store again.
        let lastRequestStorage = storage

        // The store read on the request path. An unchanged config file costs
        // one stat. A changed one is read without any lock (loadAccounts only
        // reads), waiting at most HOT_PATH_READ_BUDGET_MS before going ahead
        // with the last snapshot; the read then finishes in the background and
        // serves the next request. A read that fails within the budget still
        // fails the request, as an unreadable store always has.
        async function loadRequestAccounts() {
          const path = getConfigPath()
          let stat: Stats | undefined
          try {
            stat = statSync(path)
          } catch {
            stat = undefined
          }
          if (
            stat &&
            requestStorageCache?.path === path &&
            requestStorageCache.mtimeMs === stat.mtimeMs &&
            requestStorageCache.size === stat.size
          ) {
            return requestStorageCache.storage
          }
          if (!stat) requestStorageCache = undefined
          const read = loadAccounts(getAccountPaths(path)).then((next) => {
            if (stat) {
              requestStorageCache = {
                path,
                mtimeMs: stat.mtimeMs,
                size: stat.size,
                storage: next,
              }
            }
            lastRequestStorage = next
            return next
          })
          return settleWithinBudget(
            read,
            HOT_PATH_READ_BUDGET_MS,
            () => lastRequestStorage,
          )
        }

        function invalidateRequestStorageCache() {
          requestStorageCache = undefined
        }

        // Derive the main account's stable ChatGPT identity from the live
        // token on every invocation so storage.mainAccountId stays current
        // (migrateIfNeeded only sets it once on first run). The CLI add path
        // rejects against the persisted value — acceptable because the plugin
        // refreshes it here each time the auth loader runs.
        if (storage && auth.access && !slotTombstoned) {
          const liveAccountId = extractAccountId({
            id_token: '',
            access_token: auth.access,
            refresh_token: auth.refresh ?? '',
          })
          if (liveAccountId && liveAccountId !== storage.mainAccountId) {
            // Authoritative RMW: a stale saveAccounts here would union this
            // loader's snapshot back over disk and could resurrect a
            // concurrently-removed account (and its secrets in the state file).
            await writeLoaderSettings((current) => {
              current.mainAccountId = liveAccountId
            })
            storage.mainAccountId = liveAccountId
            invalidateRequestStorageCache()
          }
        }

        // Restore persisted log level from stored config.
        const storedLevel = storage?.logging?.level
        if (storedLevel && typeof storedLevel === 'string') {
          setLogLevel(storedLevel as Parameters<typeof setLogLevel>[0])
        }

        // Transport logging follows the persisted runtime log level.
        const logT = createLogger('transport')
        const logQ = createLogger('quota')
        const logR = createLogger('refresh')
        const logA = createLogger('accounts')

        // One-line resolved-config marker so the active endpoint/transport is
        // observable in the file log without enabling request dumps.
        logT.info('codex auth loader ready', {
          codexApiEndpoint,
          transport: getSettings().rawWebSocket
            ? 'raw-websocket'
            : getSettings().webSockets
              ? 'websocket'
              : 'http',
        })

        const quotaManager = new QuotaManager({
          storage,
          configPath: getConfigPath(),
          fetchQuotaFn: undefined, // push-only: quota comes from HTTP headers / WS frames
        })
        let currentMainIdentity: string | undefined
        let mainIdentityGeneration = 0

        // On a migrated install (the slot holds the pool placeholder and the
        // config carries `openaiAuthPool.migratedAt`) requests are served from
        // the account pool through this source; see core/pool-request.ts. On
        // any other install it only reads the config once here and stays
        // idle. The first read is awaited because the loader is not the
        // request path; it also starts every row's first quota poll.
        poolAccountSource?.dispose()
        const poolSource = new PoolAccountSource({
          paths: () => getAccountPaths(getConfigPath()),
          refreshProvider: async (credential) => {
            const tokens = await codexRefreshFn({
              refreshToken: credential.refresh,
              fetchImpl: fetch,
              now: Date.now,
            })
            const identity = extractAccountId({
              id_token: '',
              access_token: tokens.access,
              refresh_token: tokens.refresh,
            })
            return { ...tokens, ...(identity ? { identity } : {}) }
          },
          pullQuota: async (request) => {
            const credential = request.credential
            if (credential.type !== 'oauth' || !credential.access)
              throw new Error('the row holds no access token to poll with')
            const snapshot = await whamUsageFn({
              accessToken: credential.access,
              fetchImpl: fetch,
              now: Date.now,
              ...(request.identity ? { accountId: request.identity } : {}),
              accountKey: request.id,
              logger: logQ,
            })
            // The pool's quota map keeps the windows and the credit budget
            // but not the reset-credit count, which only this poll reports.
            // The in-memory quota cache keeps the whole reading, the way a
            // legacy poll leaves it, for the sidebar's reset credits and the
            // reset-credit routing tie-break.
            const checkedAt = Date.now()
            const entry = {
              quota: snapshot,
              refreshAfter: checkedAt + 5 * 60 * 1000,
              checkedAt,
            }
            if (request.id === 'main') {
              quotaManager.setMain(
                credential.access,
                entry,
                request.identity,
                true,
              )
            } else {
              quotaManager.setFallback(
                request.id,
                entry,
                credential.access,
                true,
                request.identity,
              )
            }
            return observationFromSnapshot(snapshot, checkedAt, true)
          },
          vaultIdentities: () => vault.identities(),
          vaultFirstRoster,
          vaultFirstRosterBackgroundWaitMs: vaultRosterWaitMs,
          log: createLogger('pool'),
        })
        poolAccountSource = poolSource
        await poolSource.load()
        const fallbackManager = new FallbackAccountManager({
          paths: getAccountPaths(getConfigPath()),
          refreshFn: (opts) =>
            codexRefreshFn({
              refreshToken: opts.refreshToken,
              fetchImpl: opts.fetchImpl,
              now: opts.now,
            }),
          quotaManager,
          onFallbackStorageChanged: invalidateRequestStorageCache,
          // On a migrated install the roster rows are pool rows, which the
          // pool source refreshes; this background refresh must not.
          backgroundRefreshPaused: () => poolSource.active(),
        })
        // Start background refresh only when fallback accounts are configured;
        // single-account paths must not create extra token refresh traffic.
        if (storage && storage.accounts.length > 0) {
          fallbackManager.startBackgroundRefresh()
        }

        // The bearer a legacy roster row sends with: its stored access token,
        // or none for a row holding a tombstone (or no token at all).
        function localAccountAccess(account: OAuthAccount): string | undefined {
          if (isTombstoned(account)) return undefined
          return account.access || undefined
        }
        function buildRefreshAllQuotaDeps(
          overrides: Partial<
            Pick<
              Parameters<typeof refreshAllQuota>[0],
              'respectBackoff' | 'skipFresherThanMs' | 'readSidebarState'
            >
          > = {},
        ): Parameters<typeof refreshAllQuota>[0] {
          const { readSidebarState, respectBackoff, skipFresherThanMs } =
            overrides
          return {
            getAuth,
            codexRefreshFn,
            refreshMainWithLease: refreshMainToken,
            fallbackManager,
            quotaManager,
            loadAccounts,
            writeSidebarState: writeMachineSidebarState,
            client: input.client as Parameters<
              typeof refreshAllQuota
            >[0]['client'],
            fetchImpl: fetch,
            now: Date.now,
            paths: getAccountPaths(getConfigPath()),
            readSidebarState:
              readSidebarState ?? (() => getSidebarState(boundSidebarFile)),
            storageMainAccountId: storage?.mainAccountId,
            isOAuthAccountFn: isOAuthAccount,
            whamFn: whamUsageFn,
            ...(respectBackoff === undefined ? {} : { respectBackoff }),
            ...(skipFresherThanMs === undefined ? {} : { skipFresherThanMs }),
          }
        }

        // A manual quota check on a migrated install (the `/openai` menu's quota check, the
        // reset command's precondition): polls the named rows, or every row,
        // through the pool source, in the result shape the commands report.
        async function pollPoolRows(
          ids?: readonly string[],
        ): Promise<RefreshAllQuotaResult[]> {
          const results = await poolSource.pollRows(
            await loadAccounts(getAccountPaths(getConfigPath())),
            ids ? { ids } : {},
          )
          return results.map((result) => ({
            account: result.id,
            ok: result.ok,
            ...(result.error !== undefined ? { error: result.error } : {}),
          }))
        }

        // The bearer for one pool row outside a request (cachekeep, reset
        // credits): refreshed through the pool source when due, never through
        // the legacy per-account refresh or the host slot.
        async function poolRowAccess(id: string) {
          return poolSource.accessFor(
            id,
            await loadAccounts(getAccountPaths(getConfigPath())),
          )
        }

        // -------------------------------------------------------------------
        // CacheKeepManager — prompt-cache warmer for idle main-agent sessions
        // -------------------------------------------------------------------
        const cacheKeepLogger = createLogger('cachekeep')
        // Read under either name: a migrated install renames `cachekeep` to
        // `cacheKeep` on its first settings write.
        const storedCacheKeep = cacheKeepSettings(storage)
        let cacheKeepEnabled = storedCacheKeep?.enabled === true
        let cacheKeepSubagents = storedCacheKeep?.subagents === true
        let cacheKeepSustain = storedCacheKeep?.sustain === true
        let cacheKeepWindow = getCacheKeepWindow(
          storage ? { ...storage, cachekeep: storedCacheKeep } : storage,
        )
        let mainRefreshPromise:
          | Promise<{ access: string; refresh: string; expires: number }>
          | undefined

        async function sleep(ms: number) {
          await new Promise((resolve) => setTimeout(resolve, ms))
        }

        async function persistMainAuthTokens(tokens: {
          access: string
          refresh: string
          expires: number
        }) {
          let lastError: unknown
          for (let attempt = 1; attempt <= AUTH_SET_MAX_ATTEMPTS; attempt++) {
            try {
              await input.client.auth.set({
                path: { id: 'openai' },
                body: {
                  type: 'oauth',
                  refresh: tokens.refresh,
                  access: tokens.access,
                  expires: tokens.expires,
                },
              })
              return
            } catch (error) {
              lastError = error
              if (attempt < AUTH_SET_MAX_ATTEMPTS) {
                await sleep(AUTH_SET_RETRY_BASE_MS * attempt)
              }
            }
          }
          throw new AuthPersistError(lastError)
        }

        async function updateMainRefreshState(
          update: (storage: AccountStorage) => void,
        ) {
          // Every caller holds `main-refresh` already, so the write must not
          // take it again.
          await writeLoaderSettings(
            (current) => {
              current.refresh = current.refresh ?? {}
              update(current)
            },
            { holdsMainRefreshLock: true },
          )
          invalidateRequestStorageCache()
        }

        async function waitForConcurrentMainRefresh(previous: {
          access?: string
          refresh?: string
          expires?: number
        }) {
          const deadline = Date.now() + CONCURRENT_MAIN_REFRESH_WAIT_MS
          while (Date.now() < deadline) {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                CONCURRENT_MAIN_REFRESH_POLL_BASE_MS +
                  jitterMs(CONCURRENT_MAIN_REFRESH_POLL_BASE_MS),
              ),
            )
            const latest = await getAuth()
            // Main moved into the account pool while this process waited.
            if (isPoolMainPlaceholder(latest))
              throw new MainAccountInPoolError()
            if (latest.type !== 'oauth' || !latest.access) continue
            const changed =
              latest.access !== previous.access ||
              latest.refresh !== previous.refresh ||
              (latest.expires ?? 0) > (previous.expires ?? 0) + 60_000
            if (changed && (!latest.expires || latest.expires > Date.now())) {
              logR.debug('joined concurrent main refresh', {
                pid: process.pid,
                expiresInMs: latest.expires
                  ? latest.expires - Date.now()
                  : undefined,
              })
              return {
                access: latest.access,
                refresh: latest.refresh ?? previous.refresh ?? '',
                expires: latest.expires ?? 0,
              }
            }
          }
          return null
        }

        // The refresh token in a slot value, or a throw when the value must not
        // be refreshed: the pool placeholder or the old custody tombstone (main
        // lives in the pool row), any other tombstone, or a slot with no
        // refresh token.
        function refreshableMainToken(auth: {
          type: string
          access?: string
          refresh?: string
          expires?: number
        }): string {
          if (isPoolMainPlaceholder(auth)) throw new MainAccountInPoolError()
          if (auth.type !== 'oauth') throw new Error('not oauth')
          if (isTombstoned(auth)) throw new TombstoneRefreshError()
          if (!auth.refresh) {
            throw new Error('Token refresh failed: missing refresh token')
          }
          return auth.refresh
        }

        async function refreshMainWithLease() {
          if (!mainRefreshPromise) {
            mainRefreshPromise = (async () => {
              const freshAuth = await getAuth()
              const freshRefresh = refreshableMainToken(freshAuth)
              if (freshAuth.type !== 'oauth') throw new Error('not oauth')

              const freshTokenHash = hashRefreshToken(freshRefresh)
              const latestStorage = await loadAccounts(
                getAccountPaths(getConfigPath()),
              )
              const mainError = latestStorage?.refresh?.mainLastRefreshError
              if (
                mainError &&
                refreshBackoffActive(mainError, freshRefresh, Date.now())
              ) {
                throw new Error(
                  formatRefreshBackoffMessage(mainError, Date.now()),
                )
              }

              if (
                latestStorage?.refresh?.mainRefreshLeaseUntil &&
                latestStorage.refresh.mainRefreshLeaseUntil > Date.now() &&
                latestStorage.refresh.mainRefreshLeaseTokenHash ===
                  freshTokenHash
              ) {
                const concurrent = await waitForConcurrentMainRefresh(freshAuth)
                if (concurrent) return concurrent
                throw new Error('Codex OAuth refresh is already in progress')
              }

              const fileLock = await acquireRefreshFileLock({
                name: MAIN_REFRESH_LOCK_NAME,
                ttlMs: MAIN_REFRESH_LOCK_TTL_MS,
                path: getConfigPath(),
                renew: true,
              })
              if (!fileLock) {
                const concurrent = await waitForConcurrentMainRefresh(freshAuth)
                if (concurrent) return concurrent
                throw new Error('Codex OAuth refresh is already in progress')
              }

              // Read the slot again now that the lock is held. Everything
              // above ran unlocked, so another process may since have rotated
              // the token (refreshing the one read earlier would spend a
              // refresh token that is already spent) or moved main into the
              // account pool (the slot then holds only the placeholder).
              let current: {
                access?: string
                refresh: string
                expires?: number
              }
              try {
                const underLock = await getAuth()
                const underLockRefresh = refreshableMainToken(underLock)
                if (underLock.type !== 'oauth') throw new Error('not oauth')
                if (underLockRefresh !== freshRefresh) {
                  if (
                    underLock.access &&
                    (underLock.expires ?? 0) > Date.now()
                  ) {
                    logR.debug('main token rotated while awaiting the lock', {
                      pid: process.pid,
                    })
                    await fileLock.release().catch(() => {})
                    return {
                      access: underLock.access,
                      refresh: underLockRefresh,
                      expires: underLock.expires ?? 0,
                    }
                  }
                  const storageNow = await loadAccounts(
                    getAccountPaths(getConfigPath()),
                  )
                  const currentError = storageNow?.refresh?.mainLastRefreshError
                  if (
                    currentError &&
                    refreshBackoffActive(
                      currentError,
                      underLockRefresh,
                      Date.now(),
                    )
                  ) {
                    throw new Error(
                      formatRefreshBackoffMessage(currentError, Date.now()),
                    )
                  }
                }
                current = { ...underLock, refresh: underLockRefresh }
              } catch (error) {
                await fileLock.release().catch(() => {})
                throw error
              }

              // A pending-transfer record left by a migration run that never
              // finished would keep this refresh standing down for good; once
              // it has expired, and dropping it cannot leave a second
              // refresher of this token, it goes and the refresh proceeds.
              await reclaimExpiredPoolTransfer(
                getAccountPaths(getConfigPath()),
                current.refresh,
                current.access !== undefined
                  ? { slotAccess: current.access }
                  : {},
              ).catch(() => false)

              const refreshTokenHash = hashRefreshToken(current.refresh)
              const leaseId = crypto.randomUUID()
              let leaseTokenHash: string | undefined = refreshTokenHash
              try {
                await updateMainRefreshState((nextStorage) => {
                  // Checked in the same locked write that sets the lease:
                  // either the migration's pending record was written first
                  // and this refresh never starts, or this lease was, and
                  // the migration sees it and plans again (see the
                  // lock-order note in core/pool-migration.ts).
                  if (
                    poolTransferPendingInConfigFile(
                      getConfigPath(),
                      current.refresh,
                    )
                  )
                    throw new PoolTransferPendingError()
                  nextStorage.refresh = nextStorage.refresh ?? {}
                  nextStorage.refresh.mainRefreshLeaseId = leaseId
                  nextStorage.refresh.mainRefreshLeaseUntil =
                    Date.now() + MAIN_REFRESH_LEASE_TTL_MS
                  nextStorage.refresh.mainRefreshLeaseTokenHash =
                    refreshTokenHash
                })

                const latestLease = await loadAccounts(
                  getAccountPaths(getConfigPath()),
                )
                if (
                  latestLease?.refresh?.mainRefreshLeaseId !== leaseId ||
                  latestLease.refresh.mainRefreshLeaseTokenHash !==
                    refreshTokenHash
                ) {
                  throw new Error('Codex OAuth refresh is already in progress')
                }

                const tokens = await codexRefreshFn({
                  refreshToken: current.refresh,
                  fetchImpl: fetch,
                  now: Date.now,
                })
                await persistMainAuthTokens(tokens)
                await updateMainRefreshState((nextStorage) => {
                  nextStorage.refresh = nextStorage.refresh ?? {}
                  nextStorage.refresh.mainLastRefreshError = undefined
                  if (nextStorage.refresh.mainRefreshLeaseId === leaseId) {
                    nextStorage.refresh.mainRefreshLeaseId = undefined
                    nextStorage.refresh.mainRefreshLeaseUntil = undefined
                    nextStorage.refresh.mainRefreshLeaseTokenHash = undefined
                  }
                }).catch(() => {})
                leaseTokenHash = undefined
                return tokens
              } catch (error) {
                if (!(error instanceof PoolTransferPendingError)) {
                  if (!isAuthPersistError(error)) {
                    await updateMainRefreshState((nextStorage) => {
                      nextStorage.refresh = nextStorage.refresh ?? {}
                      nextStorage.refresh.mainLastRefreshError =
                        buildRefreshOperationError({
                          error,
                          now: Date.now(),
                          refreshToken: current.refresh,
                          previous: nextStorage.refresh.mainLastRefreshError,
                        })
                    }).catch(() => {})
                  }
                  throw error
                }
              } finally {
                if (leaseTokenHash) {
                  await updateMainRefreshState((nextStorage) => {
                    if (
                      nextStorage.refresh?.mainRefreshLeaseId === leaseId &&
                      nextStorage.refresh.mainRefreshLeaseTokenHash ===
                        leaseTokenHash
                    ) {
                      nextStorage.refresh.mainRefreshLeaseId = undefined
                      nextStorage.refresh.mainRefreshLeaseUntil = undefined
                      nextStorage.refresh.mainRefreshLeaseTokenHash = undefined
                    }
                  }).catch(() => {})
                }
                await fileLock.release().catch(() => {})
              }
              // Reached only when a pool transfer covers this token: nothing
              // was sent, the lock is released (the migration needs it to
              // write the placeholder), and this waits for the slot to
              // change. The placeholder there ends the wait with
              // MainAccountInPoolError, which callers serve from row `main`.
              const concurrent = await waitForConcurrentMainRefresh(current)
              if (concurrent) return concurrent
              throw new Error('Codex OAuth refresh is already in progress')
            })().finally(() => {
              mainRefreshPromise = undefined
            })
          }
          return mainRefreshPromise
        }

        // The main account's credential while the slot holds the pool
        // placeholder: the pool row `main`, refreshed through the per-row
        // refresh path. Undefined when that row has no usable token.
        function resolvePooledMain(
          currentStorage: Awaited<ReturnType<typeof loadAccounts>>,
        ): Promise<PoolMainAccess | undefined> {
          return resolvePoolMainAccess({
            storage: currentStorage,
            now: Date.now,
            refreshAccount: (account, accountStorage) =>
              fallbackManager.refreshAccount(account, accountStorage, {
                asPoolMain: true,
              }),
            warn: (message, meta) =>
              logR.warn(message, { pid: process.pid, ...meta }),
          })
        }

        async function pooledMainTokens() {
          const pooled = await resolvePooledMain(
            await loadAccounts(getAccountPaths(getConfigPath())),
          )
          if (!pooled) {
            throw new Error(
              'The main OpenAI account has no usable token in the account pool',
            )
          }
          return {
            access: pooled.token,
            refresh: pooled.account.refresh,
            expires: pooled.account.expires ?? 0,
          }
        }

        // refreshMainWithLease for callers that only need a working main
        // token: when main turns out to live in the pool, the pool row's
        // token is returned instead of an error.
        async function refreshMainToken() {
          try {
            return await refreshMainWithLease()
          } catch (error) {
            if (error instanceof MainAccountInPoolError) {
              return pooledMainTokens()
            }
            throw error
          }
        }
        const cacheKeepGlobal = globalThis as {
          __openaiAuthCacheKeepManagers?: Map<string, OpenAICacheKeepManager>
        }
        const cacheKeepManagers =
          cacheKeepGlobal.__openaiAuthCacheKeepManagers ?? new Map()
        cacheKeepGlobal.__openaiAuthCacheKeepManagers = cacheKeepManagers
        cacheKeepManagers.get(cacheKeepKey)?.stop()
        const cacheKeepManager = createCacheKeepManager({
          fetchImpl: fetch,
          getMainToken: async () => {
            // A migrated install's main account is the pool row `main`; the
            // slot is never read for it.
            if (await poolSource.active()) {
              const access = await poolRowAccess('main')
              if (!access) throw new Error('main pool row has no usable token')
              return access.token
            }
            const auth = await getAuth()
            // Main lives in the pool row; the placeholder is never refreshed.
            if (isPoolMainPlaceholder(auth)) {
              return (await pooledMainTokens()).access
            }
            if (auth.type !== 'oauth') throw new Error('not oauth')
            if (!auth.access || (auth.expires ?? 0) < Date.now()) {
              try {
                return (await refreshMainToken()).access
              } catch (error) {
                if (isAuthPersistError(error)) throw error
                if (auth.access) return auth.access
                throw new Error('main token refresh failed')
              }
            }
            return auth.access
          },
          refreshFallback: async (accountId: string) => {
            if (await poolSource.active()) {
              // The warmed request recorded the pool row that served it.
              const access = await poolRowAccess(accountId)
              if (!access) throw new Error(`no access token for ${accountId}`)
              return { token: access.token }
            }
            const fbStorage = await loadRequestAccounts()
            const account = fbStorage
              ? findCachekeepFallbackAccount(fbStorage.accounts, accountId)
              : undefined
            if (!account)
              throw new Error(`fallback account ${accountId} not found`)
            const currentStorage = fbStorage ?? {
              version: 1 as const,
              accounts: [account],
            }
            const resolved = isTombstoned(account)
              ? account
              : await fallbackManager.refreshAccount(account, currentStorage)
            const token = localAccountAccess(resolved)
            if (!token) throw new Error(`no access token for ${accountId}`)
            return { token }
          },
          codexResponsesUrl: codexApiEndpoint,
          // The account the session routes to now: a session moved to another
          // account is not warmed on the one it left. This process's sticky
          // pins that are not saved yet are applied, as the router applies
          // them, so a warm follows the same account choice as a request.
          activeAccount: async (routingSessionId) =>
            routedAccountForSession(
              applyStickyPinOverlay(
                await sidebarCache.read(),
                stickyPinOverlay,
              ),
              routingSessionId,
            ),
          logger: cacheKeepLogger,
          now: Date.now,
          // Read on every call, so changes from the `/openai` Cache section apply live.
          getWindow: () => cacheKeepWindow,
          getSustain: () => cacheKeepSustain,
        })
        cacheKeepManagers.set(cacheKeepKey, cacheKeepManager)
        ownedCacheKeepManagers.set(cacheKeepKey, cacheKeepManager)

        // Records a quota snapshot from a response or a WebSocket frame. The
        // in-memory quota cache, which every routing decision reads, is updated
        // before this returns; the sidebar copy is written in the background.
        // Never throws, so the WebSocket frame handler and the request path can
        // call it without guarding.
        function pushQuota(
          snapshot: Record<string, unknown>,
          accessToken: string,
          accountId?: string,
          // ChatGPT account identity for the MAIN account, so the killswitch's
          // policy read survives a token refresh but still drops on a switch.
          mainAccountIdentity?: string,
          completeSnapshot = false,
        ): void {
          try {
            recordPushedQuota(
              snapshot,
              accessToken,
              accountId,
              mainAccountIdentity,
              completeSnapshot,
            )
          } catch (error) {
            logQ.warn('quota push failed', {
              pid: process.pid,
              accountId: accountId ?? 'main',
              error: errorMessage(error),
            })
          }
        }

        function recordPushedQuota(
          snapshot: Record<string, unknown>,
          accessToken: string,
          accountId: string | undefined,
          mainAccountIdentity: string | undefined,
          completeSnapshot: boolean,
        ): void {
          if (Object.keys(snapshot).length === 0 && !completeSnapshot) return
          const now = Date.now()
          const quota = snapshot as OAuthQuotaSnapshot
          let entry: Parameters<typeof quotaManager.setMain>[1] = {
            quota,
            refreshAfter: now + 5 * 60 * 1000,
            checkedAt: now,
          }
          let resolvedMainIdentity: string | undefined
          if (accountId && accountId !== 'main') {
            // Bind the pushed snapshot to the ChatGPT identity of the token
            // that carried it (same derivation as main below), so a re-login on
            // this stable id stays detectable and the sidebar never pairs a
            // stale identity's quota with the new one.
            const fallbackClaims = accessToken
              ? parseJwtClaims(accessToken)
              : null
            const fallbackIdentity = fallbackClaims
              ? extractAccountIdFromClaims(fallbackClaims)
              : undefined
            // Quota-bearing transports report every live window rather than a
            // partial subset, so an absent slot means the wire dropped it.
            // Only the wham-only reset-credit metadata carries forward.
            const previousForMetadata =
              quotaManager.peekFallbackForPolicy(accountId)?.quota
            const mergedQuota = mergePushedQuotaMetadata(
              quota,
              previousForMetadata,
            )
            entry = { ...entry, quota: mergedQuota }
            quotaManager.setFallback(
              accountId,
              entry,
              accessToken,
              completeSnapshot,
              fallbackIdentity,
            )
          } else {
            resolvedMainIdentity = mainAccountIdentity
            if (!resolvedMainIdentity && accessToken) {
              const claims = parseJwtClaims(accessToken)
              resolvedMainIdentity = claims
                ? extractAccountIdFromClaims(claims)
                : undefined
            }
            if (
              resolvedMainIdentity &&
              currentMainIdentity &&
              resolvedMainIdentity !== currentMainIdentity
            ) {
              logQ.debug('stale main quota frame dropped', {
                pid: process.pid,
                frameAccountId: resolvedMainIdentity,
                currentMainIdentity,
              })
              return
            }
            const previousForMetadata =
              quotaManager.peekMainForPolicy(resolvedMainIdentity)?.quota
            const mergedQuota = mergePushedQuotaMetadata(
              quota,
              previousForMetadata,
            )
            entry = { ...entry, quota: mergedQuota }
            quotaManager.setMain(
              accessToken,
              entry,
              resolvedMainIdentity,
              completeSnapshot,
            )
          }
          logQ.debug('quota pushed', {
            pid: process.pid,
            accountId: accountId ?? 'main',
            snapshot: entry.quota,
          })
          // On a migrated install the account pool is where routing reads
          // quota: record the same snapshot against the row that served it
          // (`main` for the main bucket). A no-op on any other install.
          poolSource.recordSnapshot(
            accountId && accountId !== 'main' ? accountId : 'main',
            snapshot,
            accessToken,
            completeSnapshot,
          )
          const fallbackPush = Boolean(accountId && accountId !== 'main')
          sidebarBookkeepingQueue.enqueue('machine-state', 'quota', () => {
            // The sidebar state is built when this queued write starts (and
            // again on a retry), from the in-memory quota cache and the
            // newest account-store snapshot at that moment.
            const latestStorage = lastRequestStorage
            return writeMachineSidebarState(
              quotaManager,
              latestStorage,
              fallbackPush
                ? latestStorage?.mainAccountId
                : resolvedMainIdentity,
            )
          })
        }

        // The pure resolver prefers an admission error's explicit reset and
        // otherwise uses this account's cached named-window quota.
        function midStreamRateLimitResetAt(
          accountKey: string,
          window: string,
          explicitResetAt?: number,
        ): number {
          const quota =
            accountKey === 'main'
              ? quotaManager.peekMainForPolicy()?.quota
              : quotaManager.peekFallbackForPolicy(accountKey)?.quota
          return resolveMidStreamRateLimitResetAt(
            quota,
            window,
            Date.now(),
            DEFAULT_MID_STREAM_RATE_LIMIT_RESET_MS,
            explicitResetAt,
          )
        }

        const websocketFetch = options.experimentalWebSockets
          ? OpenAIWebSocketPool.createWebSocketFetch({
              httpFetch: fetch,
              rawWebSocket: getSettings().rawWebSocket,
              // Per-request account identity is captured at send time by the
              // pool and threaded here so the frame is attributed to the
              // connection's own account, not the shared mutable globals.
              onQuota: (s, accessToken, accountId, servedChatgptAccountId) => {
                const isMainBucket = !accountId || accountId === 'main'
                pushQuota(
                  s,
                  accessToken,
                  accountId,
                  isMainBucket ? servedChatgptAccountId : undefined,
                  true,
                )
              },
              // WS quota exhaustion is authoritative without a quota-API call.
              // Admission errors supply their own reset; response.failed uses
              // the cached named-window reset or the bounded default.
              onRateLimitReached: (window, accountId, explicitResetAt) => {
                if (!accountId) {
                  // The loader always sets the internal quota-account header,
                  // so this should never fire today — but a future call site
                  // that bypasses it would otherwise misattribute the mark
                  // onto main's bucket with zero signal.
                  logQ.warn(
                    'mid-stream rate-limit mark missing internal account id; defaulting to main',
                    { pid: process.pid, window },
                  )
                }
                const accountKey = accountId ?? 'main'
                const resetAt = midStreamRateLimitResetAt(
                  accountKey,
                  window,
                  explicitResetAt,
                )
                quotaManager.markRateLimited(accountKey, resetAt)
                poolSource.markRateLimited(accountKey, resetAt)
                logQ.debug('mid-stream rate limit mark', {
                  pid: process.pid,
                  accountId: accountKey,
                  window,
                })
              },
            })
          : undefined
        if (websocketFetch) {
          websocketFetches.push(websocketFetch)
          websocketFetchInstalled = true
        }

        // -------------------------------------------------------------------
        // Machine snapshots refresh shared quota and routing configuration;
        // request writers record only the account that served that request.
        //
        // The sidebar path is resolved ONCE here (at loader-run time) and
        // captured in boundSidebarFile. All writes from this loader instance
        // — including fire-and-forget boot-seed and background timer callbacks
        // — pass the bound path explicitly so they cannot re-resolve
        // getSidebarStateFile() if the env changes underneath them (e.g.
        // during tests where afterEach restores the env floor).
        // -------------------------------------------------------------------
        const boundSidebarFile = getSidebarStateFile()
        sidebarStateFileForEvents = boundSidebarFile

        async function writeMachineSidebarState(
          qm: QuotaManager,
          store: Awaited<ReturnType<typeof loadAccounts>>,
          mainAccountIdentity = store?.mainAccountId,
        ) {
          // A migrated install's accounts are the pool's rows: row `main` is
          // the main account and the rest follow in roster order, with the
          // quota the pool holds for each.
          const pool = await poolSource.current()
          if (pool.active) {
            await setSidebarMachineState(
              buildPoolSidebarMachineState(
                pool.rows,
                store,
                Date.now(),
                (id) =>
                  (id === 'main' ? qm.getMain() : qm.getFallback(id))?.quota
                    ?.resetCreditsAvailable,
              ),
              boundSidebarFile,
            )
            return
          }
          if (!store) return
          await setSidebarMachineState(
            buildSidebarMachineState(
              qm,
              store,
              Date.now(),
              mainAccountIdentity,
            ),
            boundSidebarFile,
          )
        }

        // -------------------------------------------------------------------
        // Request-path sidebar access. The sidebar file is bookkeeping, so the
        // request path never waits on its lock: reads come from a cache (one
        // stat when unchanged, see createSidebarStateCache) and every write is
        // handed to a background queue that logs a failure once and retries it
        // until it lands. After a write lands the cache is refreshed so the
        // next request starts warm.
        // -------------------------------------------------------------------
        const sidebarCache = createSidebarStateCache(boundSidebarFile)
        // Warm the cache so the first request normally finds it filled. A
        // request that still finds it empty does one bounded lock-free read.
        void sidebarCache.read()
        sidebarBookkeeping?.stop()
        const sidebarBookkeepingQueue = createSidebarBookkeepingQueue({
          logger: logT,
          onWritten: () => sidebarCache.refreshInBackground(),
        })
        sidebarBookkeeping = sidebarBookkeepingQueue
        if (stickyPinOverlayFile !== boundSidebarFile) {
          // Session-to-account pins belong to one sidebar file; clear them when
          // this loader is bound to a different file.
          stickyPinOverlay.clear()
          stickyPinOverlayFile = boundSidebarFile
        }

        // Records which account served a request, for the sidebar display.
        // Returns at once; the writes run in the background. `stickyState` is
        // the request's sidebar snapshot with this process's session-to-account
        // pins applied, so sticky mode can show a parent session's own pin.
        function queueRequestSidebarRouting(
          sessionId: string | undefined,
          parentSessionId: string | undefined,
          activeId: string,
          route: RoutingMode,
          accounts: readonly { id: string; enabled?: boolean }[] | undefined,
          stickyState: SidebarState,
        ): void {
          const input = { activeId, route, updatedAt: Date.now() }
          if (!sessionId) {
            sidebarBookkeepingQueue.enqueue('routing:legacy', 'routing', () =>
              setSidebarLegacyRouting(input, boundSidebarFile),
            )
            return
          }
          sidebarBookkeepingQueue.enqueue(
            `routing:${sessionId}`,
            'routing',
            () =>
              upsertSidebarActiveRouting(
                { sessionId, ...input },
                accounts,
                boundSidebarFile,
              ),
          )
          if (!parentSessionId || parentSessionId === sessionId) return
          if (route === 'sticky-balanced') {
            const parentPinnedId =
              stickyState.stickyAssignments?.[
                hashSidebarSessionId(parentSessionId)
              ]?.accountId
            const parentPinIsUsable =
              accounts === undefined ||
              parentPinnedId === 'main' ||
              accounts.some(
                (account) =>
                  account.enabled !== false && account.id === parentPinnedId,
              )
            if (!parentPinnedId || !parentPinIsUsable) return
            sidebarBookkeepingQueue.enqueue(
              `routing:${parentSessionId}`,
              'routing',
              () =>
                upsertSidebarActiveRouting(
                  {
                    sessionId: parentSessionId,
                    activeId: parentPinnedId,
                    route,
                    updatedAt: Date.now(),
                  },
                  accounts,
                  boundSidebarFile,
                ),
            )
            return
          }
          sidebarBookkeepingQueue.enqueue(
            `routing:${parentSessionId}`,
            'routing',
            () =>
              upsertSidebarActiveRouting(
                { sessionId: parentSessionId, ...input },
                accounts,
                boundSidebarFile,
              ),
          )
        }

        // -------------------------------------------------------------------
        // Start the loopback RPC server so the TUI can drain notifications and
        // dispatch apply commands.
        // -------------------------------------------------------------------
        activeFallbackManager?.stopBackgroundRefresh()
        activeFallbackManager = fallbackManager
        const menuPaths = getAccountPaths(getConfigPath())
        cmdCtx = menuContextForTest = {
          accountStoragePath: menuPaths.configPath,
          accountStatePath: menuPaths.statePath,
          packageVersion: PackageVersion,
          quotaManager,
          loadAccounts,
          beginAccountLogin,
          // The files this loader run serves, fixed now: the menu works on
          // them even if another project's run changes the environment.
          store: () => openAccountPool(menuPaths),
          // The menu needs the pool; until the install has migrated it shows
          // only what holds the move back (the version fence's blockers).
          migration: async () => {
            if (
              (await migratedPoolRows(
                menuPaths,
                openAccountPool(menuPaths),
              )) !== undefined
            )
              return { migrated: true }
            const fence = await (
              poolMigrationDeps.fence ??
              (() => migrationFenceOpen({ currentVersion: PackageVersion }))
            )()
            return {
              migrated: false,
              blockers: fence.open
                ? []
                : fence.blockers.map((blocker) => ({
                    pid: blocker.pid,
                    version: blocker.version,
                  })),
            }
          },
          // Re-read the pool after a change, so requests route across the
          // changed rows at once and a newly added row gets its first poll.
          afterWrite: () => poolSource.load(),
          vault,
          resolveResetTarget: createResetTargetResolver({
            getAuth,
            refreshMainWithLease,
            refreshFallbackAccount: (account, currentStorage) =>
              fallbackManager.refreshAccount(account, currentStorage),
            refreshPoolMainRow: (account, currentStorage) =>
              fallbackManager.refreshAccount(account, currentStorage, {
                asPoolMain: true,
              }),
            poolAccess: async (accountKey) =>
              poolSource.rowAccess(
                accountKey,
                await loadAccounts(getAccountPaths(getConfigPath())),
              ),
            loadAccounts,
            accountStoragePath: getConfigPath(),
            accountStatePath: getAccountStatePath(getConfigPath()),
            now: Date.now,
          }),
          ...buildResetRedemptionDeps(),
          cacheKeepManager,
          setCacheKeepEnabled: (enabled) => {
            cacheKeepEnabled = enabled
          },
          setCacheKeepSubagents: (enabled) => {
            cacheKeepSubagents = enabled
          },
          setCacheKeepSustain: (enabled) => {
            cacheKeepSustain = enabled
          },
          setCacheKeepWindow: (window) => {
            cacheKeepWindow = window
          },
          clearStickyRouting: async (sessionId) => {
            // Drop this process's copy first so neither the next request nor a
            // pending retry can put the pin back after the file is cleared.
            const sessionHash = hashSidebarSessionId(sessionId)
            const hadLocalPin = stickyPinOverlay.delete(sessionHash)
            sidebarBookkeepingQueue.cancel(`pin:${sessionHash}`)
            const removedFromFile = await clearSidebarStickyAssignment(
              sessionId,
              boundSidebarFile,
            )
            return removedFromFile || hadLocalPin
          },
          getStickyRouting: async (sessionId) =>
            resolveSessionStickyAccount(
              applyStickyPinOverlay(
                await sidebarCache.read(),
                stickyPinOverlay,
              ),
              sessionId,
            ),
          refreshSidebar: async () => {
            const store = await loadAccounts(getAccountPaths(getConfigPath()))
            await writeMachineSidebarState(quotaManager, store)
          },
          // On a migrated install every row is polled through the pool
          // source, the same path its background poll takes, and every vault
          // account through the vault.
          refreshAllQuota: async () => {
            if (await poolSource.active()) {
              const [results, vaultResults] = await Promise.all([
                pollPoolRows(),
                vault.pollStale(0),
              ])
              await writeMachineSidebarState(quotaManager, lastRequestStorage)
              return [
                ...results,
                ...vaultResults.map((result) => ({
                  account: result.id,
                  ok: result.ok,
                  ...(result.error !== undefined
                    ? { error: result.error }
                    : {}),
                })),
              ]
            }
            return refreshAllQuota(buildRefreshAllQuotaDeps())
          },
          refreshResetTargetQuota: async (accountKey) => {
            if (await poolSource.active()) {
              const [result] = await pollPoolRows([accountKey])
              return (
                result ?? {
                  account: accountKey,
                  ok: false,
                  error: 'targeted quota refresh returned no result',
                }
              )
            }
            const results = await refreshAllQuota(
              buildRefreshAllQuotaDeps({ respectBackoff: false }),
              { accountKey },
            )
            return (
              results.find((result) => result.account === accountKey) ?? {
                account: accountKey,
                ok: false,
                error: 'targeted quota refresh returned no result',
              }
            )
          },
        }

        if (rpcDir) {
          const activeRpcDir = rpcDir
          try {
            // One server per project directory per process: adopting stops a
            // server an earlier loader run left for the same directory.
            const adoption = await adoptRpcServer(
              RPC_SERVER_REGISTRY_KEY,
              activeRpcDir.dir,
              () =>
                startRpcServer({
                  dir: activeRpcDir.dir,
                  secureDir: activeRpcDir.secureDir,
                  sweepRoot: activeRpcDir.sweepRoot,
                  drain: drainNotifications,
                  apply: async (request: unknown): Promise<ApplyResult> => {
                    const parsed = parseApplyRequest(request)
                    if (!parsed) throw new Error('not an /openai apply request')
                    // biome-ignore lint/style/noNonNullAssertion: cmdCtx is set in the loader before the RPC server starts
                    return applyOpenAiMenu(cmdCtx!, parsed as ApplyRequest)
                  },
                }),
            )
            ownedRpcServers.set(activeRpcDir.dir, adoption)
          } catch {
            // RPC is best-effort; the plugin must not fail if the port file
            // can't be written (e.g. missing directory in test environments).
          }
        }

        // -------------------------------------------------------------------
        // sendWithAccessToken — the one primitive that both main and fallback
        // sends call.  Wraps the existing Codex transform + send.
        // -------------------------------------------------------------------
        async function sendWithAccessToken(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
          accessToken: string,
          accountId?: string,
          keepwarmAccountKey: string = 'main',
        ): Promise<Response> {
          // Nothing may leave here without a credential. An empty token is
          // always a local defect, but on the wire it becomes `Bearer ` and
          // comes back as a provider 401 - indistinguishable from an expired
          // or revoked account, so whoever debugs it starts at the provider
          // and not at the bug. That cost a day when a main account served
          // from the vault resolved its credential and then dropped it. Refusing here
          // makes the whole class say where it came from, once, for every
          // path that reaches the wire.
          //
          // The message is fixed text and carries no account id: a fallback's
          // id is an operator-chosen label, the host decides retries by
          // pattern-matching this string, and a label like `acct-429` would
          // read as retryable. The id goes to the log instead.
          if (!accessToken.trim()) {
            logT.warn('refusing to send a request with no access token', {
              account: keepwarmAccountKey,
              accountId,
            })
            throw new Error(EMPTY_BEARER_MESSAGE)
          }

          const headers = effectiveRequestHeaders(requestInput, init)
          headers.delete('x-api-key')
          headers.delete('api-key')
          headers.set('authorization', `Bearer ${accessToken}`)
          if (accountId) {
            headers.set('ChatGPT-Account-Id', accountId)
          }
          // Thread the internal quota STORAGE key ('main' or a fallback id) so the
          // WS pool attributes codex.rate_limits frames to the right bucket instead
          // of the wire chatgpt-account-id. Stripped before the wire as an internal
          // header. The HTTP path attributes quota directly at pushQuota.
          headers.set(
            OpenAIWebSocketPool.QUOTA_ACCOUNT_HEADER,
            keepwarmAccountKey,
          )

          const sessionID = resolveSidebarSessionId(headers)

          const codexMetadata = sessionID
            ? getCodexSessionMetadata(
                codexSessions,
                sessionID,
                persistCodexSessions,
              )
            : undefined

          const parsed =
            requestInput instanceof URL
              ? requestInput
              : new URL(
                  typeof requestInput === 'string'
                    ? requestInput
                    : requestInput.url,
                )
          const url =
            parsed.pathname.includes('/v1/responses') ||
            parsed.pathname.includes('/chat/completions')
              ? new URL(codexApiEndpoint)
              : parsed
          const prepared = prepareCodexRequest({
            init: {
              ...init,
              headers,
            },
            headers,
            metadata: codexMetadata,
            installationID,
            websocket: Boolean(
              websocketFetch && parsed.pathname.endsWith('/responses'),
            ),
            responsesLite: options.responsesLite ?? false,
            dumpSessionID: sessionID,
          })
          const requestInit = prepared.init
          const keepwarmEnabled = cacheKeepEnabled
          const keepwarmHeaders = new Headers(requestInit?.headers)
          const keepwarmCapture = buildKeepwarmCapture({
            enabled: keepwarmEnabled,
            includeSubagents: cacheKeepSubagents,
            headers: keepwarmHeaders,
            body: requestInit?.body,
          })
          if (keepwarmEnabled) {
            cacheKeepLogger.trace('cachekeep headers', {
              pid: process.pid,
              hasParent: keepwarmHeaders.has('x-parent-session-id'),
              sessionKey: keepwarmCapture?.sessionKey,
              captured: Boolean(keepwarmCapture),
              affinity: keepwarmHeaders.get('x-session-affinity'),
              opencodeSession: keepwarmHeaders.get('x-opencode-session'),
              sessionId: keepwarmHeaders.get('session-id'),
            })
          }
          if (websocketFetch && parsed.pathname.endsWith('/responses')) {
            logT.debug('WS transport', {
              pid: process.pid,
              pathname: parsed.pathname,
              accountId: keepwarmAccountKey,
            })
            if (keepwarmCapture) {
              cacheKeepManager.track({
                sessionKey: keepwarmCapture.sessionKey,
                bodyText: keepwarmCapture.bodyText,
                accountId: keepwarmAccountKey,
                isSubagent: keepwarmCapture.isSubagent,
                meta: {
                  replayHeaders: keepwarmCapture.replayHeaders,
                  chatgptAccountId: accountId,
                  routingSessionId: sessionID,
                },
              })
            }
            return websocketFetch(url, requestInit)
          }
          const finalInit =
            OpenAIWebSocketPool.withoutInternalHeaders(requestInit)
          if (typeof finalInit?.body !== 'string') {
            return fetch(url, finalInit)
          }

          // Keepwarm capture: track every request body for idle
          // prompt-cache warming. Cheap — stores the already-serialized string.
          if (keepwarmCapture) {
            cacheKeepManager.track({
              sessionKey: keepwarmCapture.sessionKey,
              bodyText: keepwarmCapture.bodyText,
              accountId: keepwarmAccountKey,
              isSubagent: keepwarmCapture.isSubagent,
              meta: {
                replayHeaders: keepwarmCapture.replayHeaders,
                chatgptAccountId: accountId,
                routingSessionId: sessionID,
              },
            })
          }

          logT.debug('HTTP transport', {
            pid: process.pid,
            pathname: parsed.pathname,
            accountId: keepwarmAccountKey,
          })
          try {
            const response = await fetch(url, finalInit)
            await dumpCodexRequest({
              sessionID,
              transport: 'http',
              phase: 'http',
              bodyText: finalInit.body,
              accountId: keepwarmAccountKey,
              url: url.toString(),
              method: finalInit.method,
              headers: finalInit.headers,
              status: response.status,
            })
            return response
          } catch (error) {
            await dumpCodexRequest({
              sessionID,
              transport: 'http',
              phase: 'http',
              bodyText: finalInit.body,
              accountId: keepwarmAccountKey,
              url: url.toString(),
              method: finalInit.method,
              headers: finalInit.headers,
              error: error instanceof Error ? error.message : String(error),
            })
            throw error
          }
        }

        // -------------------------------------------------------------------
        // Replayability guard: only Codex generation POSTs with a buffered body
        // can be retried — skip fallback and return the primary response intact.
        // -------------------------------------------------------------------
        function isReplayableRequest(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
        ) {
          const method =
            init?.method ??
            (requestInput instanceof Request ? requestInput.method : 'GET')
          if (method.toUpperCase() !== 'POST') return false
          if (typeof init?.body !== 'string') return false
          try {
            const rawUrl =
              requestInput instanceof URL
                ? requestInput.toString()
                : typeof requestInput === 'string'
                  ? requestInput
                  : requestInput.url
            return new URL(rawUrl).pathname.endsWith('/responses')
          } catch {
            return false
          }
        }

        // -------------------------------------------------------------------
        // Killswitch helpers (opt-in hard circuit-breaker on cached quota).
        // -------------------------------------------------------------------

        // Last-seen pushed quota for the MAIN account (the primary is always
        // main). Push-only: no network fetch here. Uses the NON-invalidating
        // policy peek (bound to stable account identity) so a routine token
        // refresh does not turn a known-exhausted account into "unknown" (which
        // would fail open and spend). A genuine account switch still drops it.
        function killswitchMainQuota(mainAccountIdentity: string | undefined) {
          return quotaManager.peekMainForPolicy(mainAccountIdentity)?.quota
        }

        // -----------------------------------------------------------------
        // Admission quota consultation: before probing an account, check the
        // shared sidebar file (written by every plugin process on the machine)
        // against the in-process cache, so a fresh process never spends a
        // doomed request on an account already known to be at 100%.
        // -----------------------------------------------------------------
        type AdmissionQuotaDecision =
          | { exhausted: false }
          | {
              exhausted: true
              source: 'memory' | 'file'
              resetsAt: string
              resetAtMs: number
            }

        // Freshness key for a quota snapshot: each window's own checkedAt,
        // then the snapshot-level checkedAt, then the cache entry's checkedAt.
        // Both primary and secondary windows are consulted — an account whose
        // only fresh window is the secondary must not be judged on the older
        // primary timestamp.
        function quotaCheckedAt(
          quota: AccountQuota | null | undefined,
          entryCheckedAt?: number,
        ): number | undefined {
          for (const checkedAt of [
            quota?.primary?.checkedAt,
            quota?.secondary?.checkedAt,
            quota?.checkedAt,
            entryCheckedAt,
          ]) {
            if (typeof checkedAt === 'number' && Number.isFinite(checkedAt)) {
              return checkedAt
            }
          }
          return undefined
        }

        // Picks the fresher of the in-process cache and the shared sidebar file
        // for one account, and reports which side won. The file is only
        // eligible when its row asserts the SAME identity the caller is acting
        // as: a differing id belongs to another account, and an unstamped row
        // (pre-upgrade or partially written) cannot be attributed to a known
        // identity that happens to reuse the same internal slot.
        function freshestQuotaSnapshot(
          quota: AccountQuota | null | undefined,
          entryCheckedAt: number | undefined,
          fileQuota: AccountQuota | null | undefined,
          fileAccountId?: string,
          currentAccountId?: string,
        ): {
          quota: AccountQuota | null | undefined
          quotaCheckedAt: number | undefined
          source: 'memory' | 'file'
        } {
          const memoryCheckedAt = quotaCheckedAt(quota, entryCheckedAt)
          const fileCheckedAt = quotaCheckedAt(fileQuota)
          const useFile =
            fileAccountId === currentAccountId &&
            fileQuota != null &&
            (quota === undefined ||
              (fileCheckedAt !== undefined &&
                (memoryCheckedAt === undefined ||
                  fileCheckedAt > memoryCheckedAt)))
          return {
            quota: useFile ? fileQuota : quota,
            quotaCheckedAt: useFile ? fileCheckedAt : memoryCheckedAt,
            source: useFile ? 'file' : 'memory',
          }
        }

        // Selects the fresher quota source and judges it. The file wins only
        // when strictly newer; memory wins ties; empty memory defers to a
        // valid file. A file row stamped with a DIFFERENT account identity is
        // treated as absent (fail-open) — a re-login must never be judged by
        // the previous account's exhaustion. An unstamped row (no accountId)
        // is also treated as absent when the live caller has a known identity,
        // so a pre-upgrade or partially-written row cannot misattribute its
        // exhaustion to a new account that reuses the same internal slot.
        function admissionQuotaDecision(
          memoryEntry: QuotaEntry | null,
          fileQuota: AccountQuota | null | undefined,
          now: number,
          fileAccountId?: string,
          currentAccountId?: string,
        ): AdmissionQuotaDecision {
          const memoryQuota = memoryEntry?.quota as AccountQuota | undefined
          const freshest = freshestQuotaSnapshot(
            memoryQuota,
            memoryEntry?.checkedAt,
            fileQuota,
            fileAccountId,
            currentAccountId,
          )
          const source = freshest.source
          const quota = freshest.quota
          if (!isQuotaExhausted(quota, now)) return { exhausted: false }

          const reset = exhaustedQuotaResetAt(quota, now)
          if (!reset) return { exhausted: false }
          return { exhausted: true, source, ...reset }
        }

        function logAdmissionQuotaSkip(
          accountId: string,
          decision: Extract<AdmissionQuotaDecision, { exhausted: true }>,
        ) {
          logQ.debug('admission skip: exhausted account', {
            accountId,
            source: decision.source,
            resetsAt: decision.resetsAt,
          })
        }

        // Synthetic provider-shaped 429 with a Retry-After derived from the
        // earliest known quota reset across all accounts. Returned when the
        // killswitch blocks the primary and no surviving account can serve, or
        // when admission knows the primary is temporarily unavailable for one
        // of the unconditional quota reasons.
        //
        // markResetAtMs carries the blocking account's own reset when the reason
        // has one. A known-exhausted quota uses that reset exactly; a transient
        // mid-stream mark takes the sooner of its bounded reset and any cached
        // quota reset so a missing quota snapshot cannot overstate the wait.
        //
        // On a migrated install the quotas come from the account pool's rows
        // (`quotas`), and `quota-unknown` names a request refused because no
        // account has a quota reading yet; its poll is already running, so
        // the client is told to come back shortly.
        function killswitchBlockedResponse(
          storage: AccountStorage | null,
          reason:
            | 'killswitch'
            | 'mid-stream-rate-limit'
            | 'quota-exhausted'
            | 'quota-unknown' = 'killswitch',
          markResetAtMs?: number,
          quotas?: PoolBlockQuotas,
        ): Response {
          const now = Date.now()
          const mainQuota = quotas ? quotas.main : quotaManager.getMain()?.quota
          const fallbackAccounts = quotas
            ? quotas.fallbacks
            : (storage?.accounts ?? [])
                .filter(
                  (a): a is OAuthAccount =>
                    a.enabled !== false && isOAuthAccount(a),
                )
                .map((a) => ({
                  accountId: a.id,
                  quota: quotaManager.getFallback(a.id)?.quota,
                }))
          let retryAfter = killswitchRetryAfterSeconds(
            mainQuota,
            fallbackAccounts,
            now,
            storage,
          )
          if (reason === 'quota-unknown') {
            retryAfter = POOL_QUOTA_UNKNOWN_RETRY_SECONDS
          } else if (
            reason === 'quota-exhausted' &&
            markResetAtMs !== undefined
          ) {
            retryAfter = Math.max(1, Math.ceil((markResetAtMs - now) / 1000))
          } else if (
            reason === 'mid-stream-rate-limit' &&
            markResetAtMs !== undefined
          ) {
            const markRetryAfter = Math.max(
              1,
              Math.ceil((markResetAtMs - now) / 1000),
            )
            retryAfter = Math.min(retryAfter, markRetryAfter)
          }
          const mins = Math.floor(retryAfter / 60)
          const secs = retryAfter % 60
          const message =
            reason === 'mid-stream-rate-limit'
              ? `OpenAI rate limit reached — retrying on another account. Retry in ${mins}m ${secs}s.`
              : reason === 'quota-exhausted'
                ? `OpenAI quota exhausted — retrying on another account. Retry in ${mins}m ${secs}s.`
                : reason === 'quota-unknown'
                  ? `OpenAI quota is not known yet for any available account; checking it now. Retry in ${mins}m ${secs}s.`
                  : `Killswitch: all OpenAI accounts are below their configured quota threshold. Retry in ${mins}m ${secs}s.`
          return new Response(
            JSON.stringify({
              error: {
                message,
                type: 'rate_limit_exceeded',
                code: 'rate_limit_exceeded',
              },
            }),
            {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'retry-after': String(retryAfter),
              },
            },
          )
        }

        // -------------------------------------------------------------------
        // Fallback candidate building (shared by the proactive fallback-first
        // gate and the reactive main-error path). The primary is ALWAYS main, so
        // main is never a fallback candidate here.
        // -------------------------------------------------------------------
        type FallbackCandidate = {
          access: string
          accountId?: string
          keepwarmAccountKey: string
          quotaAccountId: string
          fallback: FallbackAccount
        }

        type FallbackCandidateSelection = {
          current: FallbackCandidate[]
          retained: FallbackCandidate[]
          skipped: Array<{
            candidate: FallbackCandidate
            decision: Extract<AdmissionQuotaDecision, { exhausted: true }>
          }>
        }

        type StickyRouteCandidate = {
          accountId: string
          wireAccountId?: string
          access: string
          keepwarmAccountKey: string
          fallback?: FallbackAccount
          quota: AccountQuota | null | undefined
          quotaCheckedAt?: number
          reservePercent: { primary: number; secondary: number }
          configuredOrder: number
          resetCreditsApplicable?: number
          // Killswitch gate resolved at roster build, using the non-invalidating
          // policy peek so a routine token refresh does not flip a killed
          // account to "unknown". `false` excludes the candidate from both
          // weighted placement and the mode-fallback fail-open branch.
          killswitchPasses?: boolean
        }

        function resetCreditsApplicable(value: unknown): number | undefined {
          // Field key fix: the storage shape is `resetCreditsAvailable` on
          // both OAuthQuotaSnapshot (core/accounts.ts:88) and AccountQuota
          // (sidebar-state.ts:13). The previous read of
          // `resetCreditsApplicable` was always undefined and the
          // credit-priority sort in selectStickyCandidate never fired in
          // production. The candidate field stays named
          // `resetCreditsApplicable` so the sort comparator downstream is
          // unchanged.
          const credits = (value as { resetCreditsAvailable?: unknown } | null)
            ?.resetCreditsAvailable
          return typeof credits === 'number' && Number.isFinite(credits)
            ? credits
            : undefined
        }

        async function buildStickyRouteRoster(input: {
          storage: Awaited<ReturnType<typeof loadAccounts>>
          sidebarState: SidebarState
          primaryAccess: string
          mainAccountIdentity?: string
          mainUnavailable: boolean
        }): Promise<StickyRouteCandidate[]> {
          const killswitchEnabled = isKillswitchEnabled(input.storage)
          const killswitchNow = Date.now()
          const mainMemory = quotaManager.peekMainForPolicy(
            input.mainAccountIdentity,
          )
          const mainFreshest = freshestQuotaSnapshot(
            mainMemory?.quota as AccountQuota | undefined,
            mainMemory?.checkedAt,
            input.sidebarState.main.quota,
            input.sidebarState.main.mainAccountId,
            input.mainAccountIdentity,
          )
          // Killswitch (opt-in): pre-resolve the gate for each candidate so the
          // placement selector (weighted + mode-fallback) and the break decision
          // can both honour it without redoing the read. Undefined = passes —
          // the dominant path with killswitch disabled is byte-identical.
          const mainKillswitchPasses = killswitchEnabled
            ? killswitchPassesPolicy(
                mainMemory?.quota,
                input.storage,
                undefined,
                killswitchNow,
              )
            : undefined
          const roster: StickyRouteCandidate[] = input.mainUnavailable
            ? []
            : [
                {
                  accountId: 'main',
                  wireAccountId: input.mainAccountIdentity,
                  access: input.primaryAccess,
                  keepwarmAccountKey: 'main',
                  quota: mainFreshest.quota,
                  quotaCheckedAt: mainFreshest.quotaCheckedAt,
                  reservePercent: getKillswitchThresholdsForAccount(
                    input.storage,
                  ),
                  configuredOrder: 0,
                  resetCreditsApplicable: resetCreditsApplicable(
                    mainFreshest.quota,
                  ),
                  killswitchPasses: mainKillswitchPasses,
                },
              ]
          const usableFallbacks =
            await fallbackManager.getUsableFallbackAccounts(input.storage)
          if (!input.storage) return roster
          for (const fallback of usableFallbacks) {
            const access = localAccountAccess(fallback)
            if (!access) continue
            const fileEntry = input.sidebarState.fallbacks.find(
              (account) => account.id === fallback.id,
            )
            const memoryEntry = quotaManager.peekFallbackForPolicy(
              fallback.id,
              fallback.accountId,
            )
            const freshest = freshestQuotaSnapshot(
              memoryEntry?.quota as AccountQuota | undefined,
              memoryEntry?.checkedAt,
              fileEntry?.quota,
              fileEntry?.accountId,
              fallback.accountId,
            )
            const fallbackKillswitchPasses = killswitchEnabled
              ? killswitchPassesPolicy(
                  memoryEntry?.quota,
                  input.storage,
                  fallback.id,
                  killswitchNow,
                )
              : undefined
            roster.push({
              accountId: fallback.id,
              wireAccountId: fallback.accountId,
              access,
              keepwarmAccountKey: fallback.id,
              fallback,
              quota: freshest.quota,
              quotaCheckedAt: freshest.quotaCheckedAt,
              reservePercent: getKillswitchThresholdsForAccount(
                input.storage,
                fallback.id,
              ),
              configuredOrder: roster.length,
              resetCreditsApplicable: resetCreditsApplicable(freshest.quota),
              killswitchPasses: fallbackKillswitchPasses,
            })
          }
          return roster
        }

        function stickyBreakDecision(
          candidate: StickyRouteCandidate,
          sidebarState: SidebarState,
          status: number | undefined,
          now: number,
          storage: Awaited<ReturnType<typeof loadAccounts>> | null,
        ): StickyBreakDecision {
          // Pre-resolved by the roster builder using the non-invalidating
          // policy peek. Pass it through so a retained pin whose account has
          // fallen below floor since the pin was created migrates the same
          // way an exhausted pin does. Undefined = passes (killswitch
          // disabled or no quota seen).
          const killswitchPasses = isKillswitchEnabled(storage)
            ? candidate.killswitchPasses
            : undefined
          if (candidate.accountId === 'main') {
            const memoryEntry = quotaManager.peekMainForPolicy(
              candidate.wireAccountId,
            )
            const freshest = freshestQuotaSnapshot(
              memoryEntry?.quota as AccountQuota | undefined,
              memoryEntry?.checkedAt,
              sidebarState.main.quota,
              sidebarState.main.mainAccountId,
              candidate.wireAccountId,
            )
            return decideStickyBreak({
              quota: freshest.quota,
              quotaCheckedAt: freshest.quotaCheckedAt,
              status,
              now,
              killswitchPasses,
            })
          }
          const fileEntry = sidebarState.fallbacks.find(
            (account) => account.id === candidate.accountId,
          )
          const memoryEntry = quotaManager.peekFallbackForPolicy(
            candidate.accountId,
            candidate.wireAccountId,
          )
          const freshest = freshestQuotaSnapshot(
            memoryEntry?.quota as AccountQuota | undefined,
            memoryEntry?.checkedAt,
            fileEntry?.quota,
            fileEntry?.accountId,
            candidate.wireAccountId,
          )
          return decideStickyBreak({
            quota: freshest.quota,
            quotaCheckedAt: freshest.quotaCheckedAt,
            status,
            now,
            killswitchPasses,
          })
        }

        function stickyRateLimitKey(candidate: StickyRouteCandidate): string {
          return candidate.accountId === 'main'
            ? 'main'
            : candidate.keepwarmAccountKey
        }

        function isStickyRouteCandidateRateLimited(
          candidate: StickyRouteCandidate,
        ): boolean {
          return quotaManager.isRateLimited(stickyRateLimitKey(candidate))
        }

        // Places or keeps the session's pin and returns the candidate to send
        // with. The decision is made in memory from the request's sidebar
        // snapshot plus this process's own recent pins, exactly as the locked
        // file merge would make it; the pin and its pending-bytes entry are
        // then written in the background.
        //
        // Accepted trade-off: another process's placements reach this one
        // only through the snapshot, so a session placed elsewhere in the last
        // moment may not yet count toward pending bytes here, and a pin
        // another process wrote that the snapshot has not seen is picked up
        // on the next refresh. Placement is load balancing, not a correctness
        // boundary, so slightly stale weights are preferable to a turn that
        // waits on (or fails with) the sidebar lock.
        function resolveStickyRouteCandidate(input: {
          sessionId: string
          requestBytes: number
          candidates: readonly StickyRouteCandidate[]
          sidebarSnapshot: SidebarSnapshot
          excludeAccountIds?: readonly string[]
          now: number
        }): StickyRouteCandidate | undefined {
          const eligibleCandidates = input.candidates.filter(
            (candidate) => !isStickyRouteCandidateRateLimited(candidate),
          )
          const candidatesById = new Map(
            eligibleCandidates.map((candidate) => [
              candidate.accountId,
              candidate,
            ]),
          )
          const excluded = new Set(input.excludeAccountIds)
          const assignment = placeStickyPin({
            sessionId: input.sessionId,
            requestBytes: input.requestBytes,
            sidebarSnapshot: input.sidebarSnapshot,
            now: input.now,
            validPinnedAccountIds: [...candidatesById.keys()],
            excludeAccountIds: input.excludeAccountIds ?? [],
            quotaCheckedAtByAccount: Object.fromEntries(
              eligibleCandidates.map((candidate) => [
                candidate.accountId,
                candidate.quotaCheckedAt,
              ]),
            ),
            wireAccountIdByAccount: Object.fromEntries(
              eligibleCandidates.map((candidate) => [
                candidate.accountId,
                candidate.wireAccountId,
              ]),
            ),
            select: (pendingBytes) => {
              const eligible = eligibleCandidates.filter(
                (candidate) => !excluded.has(candidate.accountId),
              )
              if (eligible.length === 0) return undefined
              // Undefined when the killswitch blocks every candidate. The
              // caller then has no pin to send with and answers with the
              // shared `killswitchBlockedResponse`, as the ordered modes do.
              return selectStickyCandidate({
                candidates: eligible,
                pendingBytes,
                requestBytes: input.requestBytes,
                now: input.now,
                onEmptyWeightedSet: () => {
                  logA.debug(
                    'sticky routing: no fresh weighted candidates; using configured order',
                  )
                },
              })
            },
            persist: true,
          })
          return assignment
            ? candidatesById.get(assignment.accountId)
            : undefined
        }

        // The session pin ledger, shared by the legacy and the account-pool
        // request paths: decides the session's pin from the request's
        // sidebar snapshot plus this process's own recent pins (see
        // resolveStickyRouteCandidate above for the trade-off), and with
        // `persist` records a new or refreshed pin in the background.
        // Without `persist` nothing is recorded: the pool path uses that to
        // serve one request elsewhere while the session keeps its pin.
        function placeStickyPin(
          input: Omit<PoolPinPlacement, 'select'> & {
            sidebarSnapshot: SidebarSnapshot
            select: (pendingBytes: ReadonlyMap<string, number>) =>
              | {
                  accountId: string
                  quotaCheckedAt?: number
                  source: 'weighted' | 'mode-fallback'
                }
              | undefined
          },
        ) {
          // Assigned inside `choose`; the assertion keeps TypeScript from
          // narrowing it to `undefined` across that synchronous callback.
          let placement = undefined as
            | {
                accountId: string
                source: 'weighted' | 'mode-fallback'
                pendingBytes: number
              }
            | undefined
          const validPinnedAccountIds = input.validPinnedAccountIds
          const plan = planSidebarStickyAssignmentFromSnapshot(
            applyStickyPinOverlay(input.sidebarSnapshot, stickyPinOverlay),
            {
              sessionId: input.sessionId,
              requestBytes: input.requestBytes,
              now: input.now,
              validPinnedAccountIds,
              excludeAccountIds: input.excludeAccountIds,
              quotaCheckedAtByAccount: input.quotaCheckedAtByAccount,
              wireAccountIdByAccount: input.wireAccountIdByAccount,
              choose: (pendingBytes) => {
                const selected = input.select(pendingBytes)
                if (!selected) return undefined
                placement = {
                  accountId: selected.accountId,
                  source: selected.source,
                  pendingBytes: pendingBytes.get(selected.accountId) ?? 0,
                }
                return selected
              },
            },
          )
          const assignment = plan.assignment
          if (!input.persist) return assignment
          if (placement && assignment?.accountId === placement.accountId) {
            logA.debug('sticky routing: placed session pin', {
              pid: process.pid,
              sessionHash: hashSidebarSessionId(input.sessionId),
              accountId: placement.accountId,
              source: placement.source,
              requestBytes: input.requestBytes,
              pendingBytes: placement.pendingBytes,
            })
          }
          if (assignment && plan.next !== undefined) {
            const sessionHash = hashSidebarSessionId(input.sessionId)
            const entry = rememberStickyPin(
              stickyPinOverlay,
              sessionHash,
              assignment,
            )
            sidebarBookkeepingQueue.enqueue(
              `pin:${sessionHash}`,
              'sticky-pin',
              async () => {
                await persistSidebarStickyAssignment(
                  {
                    sessionId: input.sessionId,
                    assignment,
                    validPinnedAccountIds,
                  },
                  boundSidebarFile,
                )
                entry.persistedAt = Date.now()
              },
            )
          }
          return assignment
        }

        async function usableFallbackCandidates(
          fallbackStorage: Awaited<ReturnType<typeof loadAccounts>>,
          sidebarState: SidebarState,
        ): Promise<FallbackCandidateSelection> {
          const usableFallbacks =
            await fallbackManager.getUsableFallbackAccounts(fallbackStorage)
          const candidates: FallbackCandidate[] = []
          if (!fallbackStorage)
            return { current: [], retained: [], skipped: [] }
          for (const fb of usableFallbacks) {
            const access = localAccountAccess(fb)
            if (!access) continue
            candidates.push({
              access,
              accountId: fb.accountId,
              keepwarmAccountKey: fb.id,
              quotaAccountId: fb.id,
              fallback: fb,
            })
          }
          // Mid-stream rate-limit mark: never re-try a fallback a prior request
          // just exhausted mid-generation. Unlike the killswitch quota filter
          // below, this applies unconditionally — the mark comes from the
          // account's own response.failed frame, not an opt-in policy.
          const notRateLimited = candidates.filter(
            (c) => !quotaManager.isRateLimited(c.quotaAccountId),
          )
          // Killswitch: drop any candidate whose last-seen quota is below its
          // threshold so routing never spends on a killed account. Opt-in — a
          // no-op when disabled. Non-invalidating peek so a token refresh does
          // not flip a killed account to "unknown".
          const current = isKillswitchEnabled(fallbackStorage)
            ? notRateLimited.filter((c) =>
                killswitchPassesPolicy(
                  quotaManager.peekFallbackForPolicy(
                    c.quotaAccountId,
                    c.accountId,
                  )?.quota,
                  fallbackStorage,
                  c.quotaAccountId,
                  Date.now(),
                ),
              )
            : notRateLimited
          // Admission: drop candidates whose freshest known quota (memory or
          // the shared sidebar file) is exhausted, so a doomed probe is never
          // spent on them.
          const fileQuotas = new Map(
            sidebarState.fallbacks.map((account) => [
              account.id,
              { quota: account.quota, accountId: account.accountId },
            ]),
          )
          const retained: FallbackCandidate[] = []
          const skipped: FallbackCandidateSelection['skipped'] = []
          const now = Date.now()
          for (const candidate of current) {
            const fileEntry = fileQuotas.get(candidate.quotaAccountId)
            const decision = admissionQuotaDecision(
              quotaManager.peekFallbackForPolicy(
                candidate.quotaAccountId,
                candidate.accountId,
              ),
              fileEntry?.quota,
              now,
              fileEntry?.accountId,
              candidate.accountId,
            )
            if (decision.exhausted) {
              skipped.push({ candidate, decision })
            } else {
              retained.push(candidate)
            }
          }
          return { current, retained, skipped }
        }

        function applyAdmissionQuotaSafety(
          selection: FallbackCandidateSelection,
          mainRemainsCandidate: boolean,
        ): FallbackCandidate[] {
          // The shared file is advisory. If filtering it would remove the last
          // admission path, keep probing in the original wire-authority order —
          // a stale or corrupt file can never brick routing.
          if (selection.retained.length === 0 && !mainRemainsCandidate) {
            return selection.current
          }
          for (const { candidate, decision } of selection.skipped) {
            logAdmissionQuotaSkip(candidate.quotaAccountId, decision)
          }
          return selection.retained
        }

        function pushFailedFallbackQuota(
          response: Response,
          candidate: FallbackCandidate,
        ) {
          try {
            const snapshot = normalizeQuotaHeaders(response.headers)
            pushQuota(
              snapshot as Record<string, unknown>,
              candidate.access,
              candidate.quotaAccountId,
              undefined,
              isCompleteQuotaHeaderFrame(response.headers),
            )
          } catch {
            // Quota headers from a failed candidate are advisory; routing must continue.
          }
        }

        // -------------------------------------------------------------------
        // tryFallbackFirst — proactive (fallback-first mode): try usable
        // fallbacks BEFORE main. Returns the first fallback that serves, or
        // undefined if none serve so the caller falls through to main.
        // -------------------------------------------------------------------
        async function tryFallbackFirst(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
          fallbackStorage: Awaited<ReturnType<typeof loadAccounts>>,
          candidates: FallbackCandidate[],
        ): Promise<
          | {
              response: Response
              accessToken: string
              quotaAccountId: string
              activeId: string
            }
          | undefined
        > {
          for (const candidate of candidates) {
            let response: Response
            try {
              response = await sendWithAccessToken(
                requestInput,
                init,
                candidate.access,
                candidate.accountId,
                candidate.keepwarmAccountKey,
              )
            } catch (error) {
              // A caller abort and an indeterminate transport failure both
              // stop routing: the failed send may already have generated or
              // billed, so trying another account could duplicate the request.
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                throw error
              }
              if ((init?.signal as AbortSignal | undefined | null)?.aborted) {
                throw error
              }
              logA.debug(
                'fallback-first transport failed; request not replayed',
                {
                  pid: process.pid,
                  accountId: candidate.quotaAccountId,
                },
              )
              throw error
            }
            if (!shouldFallbackStatus(response.status, fallbackStorage)) {
              // Not awaited: the response is already in hand, and this only
              // stamps a telemetry timestamp nothing reads. Awaiting it puts a
              // contended store write between the provider's answer and the
              // user's screen — measured at 3.6s median and 15s worst case on a
              // busy host. markUsed swallows its own failures, so a dropped
              // stamp cannot surface as an unhandled rejection.
              void fallbackManager.markUsed(candidate.fallback)
              return {
                response,
                accessToken: candidate.access,
                quotaAccountId: candidate.quotaAccountId,
                activeId: candidate.keepwarmAccountKey,
              }
            }
            pushFailedFallbackQuota(response, candidate)
            // This fallback failed — discard its body and try the next.
            response.body?.cancel().catch(() => {})
          }
          return undefined
        }

        // -------------------------------------------------------------------
        // tryFallbackAccounts — reactive: main returned a fallback status, so
        // retry with each usable fallback's access token.
        // -------------------------------------------------------------------
        async function tryFallbackAccounts(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
          primaryResponse: Response,
          fallbackStorage: Awaited<ReturnType<typeof loadAccounts>>,
          candidates: FallbackCandidate[],
        ) {
          if (!isReplayableRequest(requestInput, init)) {
            return { response: primaryResponse }
          }

          if (!candidates.length) return { response: primaryResponse }

          // Keep the returned response body live; only cancel a response after a
          // later retry has produced a replacement.
          let lastResponse: Response = primaryResponse
          let lastQuotaTarget:
            | { accessToken: string; accountId?: string }
            | undefined

          for (const candidate of candidates) {
            let response: Response
            try {
              response = await sendWithAccessToken(
                requestInput,
                init,
                candidate.access,
                candidate.accountId,
                candidate.keepwarmAccountKey,
              )
            } catch (error) {
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                throw error
              }
              if ((init?.signal as AbortSignal | undefined | null)?.aborted) {
                throw error
              }
              logA.debug('reactive fallback candidate threw; stopping', {
                pid: process.pid,
                accountId: candidate.quotaAccountId,
              })
              return { response: lastResponse, ...lastQuotaTarget }
            }

            // Cancel the PREVIOUS response body now that we have a new one.
            // Only the LAST (returned) response keeps its body intact.
            lastResponse.body?.cancel().catch(() => {})
            lastResponse = response
            lastQuotaTarget = {
              accessToken: candidate.access,
              accountId: candidate.quotaAccountId,
            }

            if (!shouldFallbackStatus(response.status, fallbackStorage)) {
              // See the fallback-first path above: telemetry only, never awaited
              // on the request path.
              void fallbackManager.markUsed(candidate.fallback)
              return { response, ...lastQuotaTarget }
            }
            pushFailedFallbackQuota(response, candidate)
          }

          // All fallbacks exhausted. Return the last response — its body is
          // always intact (never cancelled here).
          return { response: lastResponse, ...lastQuotaTarget }
        }

        // -------------------------------------------------------------------
        // Boot-time quota seed: fire refreshAllQuota once per process so the
        // sidebar shows real numbers shortly after start instead of "checking…".
        // Non-blocking, best-effort — a failure must never crash the loader.
        // -------------------------------------------------------------------
        // Seed fallback quota from persisted account.quota so the immediate
        // machine snapshot shows last-known fallback numbers.
        if (storage) {
          const oauthAccts: OAuthAccount[] = []
          for (const a of storage.accounts) {
            if (isOAuthAccount(a)) oauthAccts.push(a)
          }
          quotaManager.seedFallbacksFromAccounts(oauthAccts)
        }

        if (!bootQuotaSeedStarted) {
          bootQuotaSeedStarted = true

          // Immediate: show persisted quota so the sidebar isn't blank
          void writeMachineSidebarState(quotaManager, storage).catch(() => {})

          // Background: refresh from the API, then the sidebar shows fresh
          // numbers. A migrated install skips it: the pool source's load
          // above already polls every pool row, and the legacy seed would
          // refresh and poll the same rows a second way.
          if (!(await poolSource.active())) {
            bootQuotaSeedPromise = refreshAllQuota(
              buildRefreshAllQuotaDeps({ respectBackoff: true }),
            ).catch((error) =>
              logQ.warn('boot quota seed failed', {
                pid: process.pid,
                error: errorMessage(error),
              }),
            )
          } else {
            bootQuotaSeedPromise = Promise.resolve()
          }
        }

        backgroundQuotaRefresh.start(
          async () => {
            // A migrated install refreshes and polls its pool rows through
            // the pool source, under the same cross-process lease; the
            // legacy pass below would read the same rows as a main slot
            // plus fallbacks.
            if (await poolSource.active()) {
              const polled = await refreshPoolInBackground(
                poolSource,
                await loadAccounts(getAccountPaths(getConfigPath())),
                () => acquireBackgroundRefreshLock(getConfigPath()),
              )
              if (polled.length > 0) {
                await writeMachineSidebarState(quotaManager, lastRequestStorage)
              }
              const failures = polled.filter((result) => !result.ok)
              if (failures.length > 0) {
                logQ.warn(
                  'background pool quota poll completed with failures',
                  {
                    pid: process.pid,
                    failures,
                  },
                )
              }
              return
            }
            const results = await refreshQuotaInBackground(
              buildRefreshAllQuotaDeps({
                // Reading through the request cache keeps it fresh on every
                // background tick as well.
                readSidebarState: async () => (await sidebarCache.read()).state,
              }),
            )
            const failures = results.filter((result) => !result.ok)
            if (failures.length > 0) {
              logQ.warn('background quota refresh completed with failures', {
                pid: process.pid,
                failures,
              })
            }
          },
          (error) => {
            logQ.warn('background quota refresh failed', {
              pid: process.pid,
              error: error instanceof Error ? error.message : String(error),
            })
          },
        )

        // -------------------------------------------------------------------
        // The request path of a migrated install: every account, main
        // included, is an account-pool row (see core/pool-request.ts). The
        // transport, quota recording, pin ledger and refusal shapes are the
        // ones the legacy path below uses.
        // -------------------------------------------------------------------
        async function servePooled(
          requestInput: RequestInfo | URL,
          init: RequestInit | undefined,
          reqStorage: Awaited<ReturnType<typeof loadAccounts>>,
          sessionId: string | undefined,
          parentSessionId: string | undefined,
          generation: number,
        ): Promise<Response> {
          const mode: RoutingMode = reqStorage?.routing?.mode ?? 'main-first'
          const mainRow = poolSource
            .peek()
            .rows.find((row) => row.id === 'main')
          const loginRequired =
            !mainRow &&
            (await poolPlaceholderWithoutMain(
              getAccountPaths(getConfigPath()),
              await getAuth(),
            ))
          if (generation === mainIdentityGeneration) {
            currentMainIdentity = mainRow?.identity
          }
          const sidebarSnapshot = await sidebarCache.get()
          const { response, servedId } = await servePoolRequest({
            source: poolSource,
            ...(vault.enrolled()
              ? {
                  vault: {
                    routes: () => vault.routes(),
                    identities: () => vault.identities(),
                    send: (id, dispatch) =>
                      vault.send(id, dispatch, {
                        site: 'model',
                        ...(init?.signal ? { signal: init.signal } : {}),
                      }),
                    requestReading: (id) => vault.requestReading(id),
                  },
                }
              : {}),
            storage: reqStorage,
            mode,
            sessionId,
            body: typeof init?.body === 'string' ? init.body : undefined,
            replayable: isReplayableRequest(requestInput, init),
            now: Date.now,
            send: (target, token) =>
              sendWithAccessToken(
                requestInput,
                init,
                token,
                target.identity,
                target.id,
              ),
            recordQuota: (served, target, token, attempt) => {
              try {
                const snapshot = normalizeQuotaHeaders(
                  served.headers,
                ) as Record<string, unknown>
                const complete = isCompleteQuotaHeaderFrame(served.headers)
                // A vault account's quota lives in the vault roster, and is
                // kept only with the receipt the response was served under.
                if (!target.row) {
                  if (attempt)
                    void vault.recordSnapshot(
                      target.id,
                      snapshot,
                      complete,
                      attempt,
                    )
                  return
                }
                pushQuota(
                  snapshot,
                  token,
                  target.id === 'main' ? undefined : target.id,
                  target.id === 'main' ? target.identity : undefined,
                  complete,
                )
              } catch {
                // Quota push is advisory; preserve the provider response.
              }
            },
            placePin: (placement) =>
              placeStickyPin({ ...placement, sidebarSnapshot }),
            blocked: (block, quotas) => {
              if (block.reason === 'no-credential') {
                // Routing has already tried every row that could serve, so
                // a missing main must not prevent a healthy fallback send.
                if (loginRequired) throw new Error(POOL_LOGIN_REQUIRED_MESSAGE)
                return new Response(null, { status: 401 })
              }
              return killswitchBlockedResponse(
                reqStorage,
                block.reason,
                block.resetAtMs,
                quotas,
              )
            },
            resetCredits: (id) =>
              resetCreditsApplicable(
                id === 'main'
                  ? quotaManager.peekMainForPolicy(mainRow?.identity)?.quota
                  : quotaManager.peekFallbackForPolicy(id)?.quota,
              ),
            isAbort: (error) =>
              (error instanceof DOMException && error.name === 'AbortError') ||
              Boolean(
                (init?.signal as AbortSignal | undefined | null)?.aborted,
              ),
            log: logA,
          })
          queueRequestSidebarRouting(
            sessionId,
            parentSessionId,
            servedId,
            mode,
            reqStorage?.accounts,
            applyStickyPinOverlay(sidebarSnapshot, stickyPinOverlay),
          )
          return response
        }

        // -------------------------------------------------------------------
        // Fetch override that selects the active account, refreshes if
        // needed, sends the transformed Codex request, and records quota.
        // -------------------------------------------------------------------
        codexFetchInstalled = true
        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const requestHeaders = effectiveRequestHeaders(requestInput, init)
            const sidebarSessionId = resolveSidebarSessionId(requestHeaders)
            const sidebarParentSessionId =
              requestHeaders.get('x-parent-session-id')?.trim() || undefined
            // Main-first and fallback-first select per request; sticky-balanced
            // resolves a per-session pin from sidebar state before sending.
            const reqStorage = await loadRequestAccounts()

            // Main primary uses opencode's auth slot.
            const currentAuth: {
              type: string
              access?: string
              refresh?: string
              expires?: number
            } = await getAuth()
            const myGeneration = ++mainIdentityGeneration
            if (currentAuth.type !== 'oauth') {
              requestHeaders.delete(OPENAI_AGENT_HEADER)
              return fetch(requestInput, { ...init, headers: requestHeaders })
            }
            init = await materializeRequestInit(requestInput, init)
            // A migrated install whose slot holds the pool placeholder (or the
            // tombstone the removed vault custody left, which says the same:
            // main lives elsewhere) is served from the account pool and the
            // vault. A real login in the slot of a migrated install keeps the
            // path below while it is adopted into the pool, unless the vault
            // serves this host its accounts: then it is refused, since
            // serving either would silently pick one of two accounts.
            const migrated = (await poolSource.current()).active
            if (isPoolMainPlaceholder(currentAuth) && migrated) {
              return servePooled(
                requestInput,
                init,
                reqStorage,
                sidebarSessionId,
                sidebarParentSessionId,
                myGeneration,
              )
            }
            if (migrated) vault.assertHostSlot(currentAuth)
            let primaryAccess = ''
            // True when main has no credential to send: the slot holds a
            // tombstone, or main lives in the account pool and its row has no
            // usable token. Main is then skipped and the fallbacks serve.
            let mainUnavailable = false
            // Set when the slot holds the account-pool placeholder, so main is
            // the pool row `main` (and that row is not also a fallback).
            let pooledMain: PoolMainAccess | undefined
            let mainInPool = isPoolMainPlaceholder(currentAuth)
            // A real credential in the slot of a migrated install is a later
            // login: this request serves it as always, and it is adopted into
            // the pool in the background.
            if (
              poolLifecycle?.migrated() &&
              !mainInPool &&
              currentAuth.refresh?.trim() &&
              classifyMainAuthSlot(currentAuth).kind === 'real'
            )
              poolLifecycle.noticeRealSlot(currentAuth.refresh)
            const usePooledMain = async (storage = reqStorage) => {
              mainInPool = true
              pooledMain = await resolvePooledMain(storage)
              if (pooledMain) {
                primaryAccess = pooledMain.token
              } else {
                primaryAccess = ''
                mainUnavailable = true
                logA.warn('main account in the pool has no usable token', {
                  pid: process.pid,
                })
              }
            }

            if (mainInPool) {
              await usePooledMain()
            } else if (isTombstoned(currentAuth)) {
              // A tombstone that is not the canonical one the pool path
              // recognises: still never a credential.
              mainUnavailable = true
            } else {
              // Refresh expired main tokens and mirror them into opencode's slot.
              if (
                !currentAuth.access ||
                (currentAuth.expires ?? 0) < Date.now()
              ) {
                logR.debug('token refresh triggered', {
                  pid: process.pid,
                  hasAccess: Boolean(currentAuth.access),
                  expiresInMs: currentAuth.expires
                    ? currentAuth.expires - Date.now()
                    : undefined,
                })
                try {
                  const refreshed = await refreshMainWithLease()
                  currentAuth.access = refreshed.access
                  currentAuth.refresh = refreshed.refresh
                  currentAuth.expires = refreshed.expires
                } catch (error) {
                  if (isAuthPersistError(error)) throw error
                  // Main moved into the account pool while this request
                  // waited; serve it from there. The store read at the
                  // start of the request predates the move (row `main` may
                  // not have existed yet), so it is read again.
                  if (error instanceof MainAccountInPoolError) {
                    await usePooledMain(
                      await loadAccounts(getAccountPaths(getConfigPath())),
                    )
                  }
                  // Otherwise use the stale token on refresh failure.
                }
              }
              if (!mainInPool) primaryAccess = currentAuth.access ?? ''
            }
            // The fallback roster for this request. While main is the pool
            // row `main`, that row is main and must not be tried again as a
            // fallback.
            const fallbackStorage = mainInPool
              ? withoutPoolMainRow(reqStorage)
              : reqStorage

            const authWithAccount = currentAuth as typeof currentAuth & {
              accountId?: string
            }
            // Stable ChatGPT identity of the CURRENT main account. Prefer the
            // auth slot's accountId, but fall back to decoding it from the live
            // access-token JWT so the killswitch/quota reads can still detect a
            // main-account SWITCH (a loader that outlives a re-auth would
            // otherwise judge account B by account A's cached quota).
            const mainAccountIdentity =
              pooledMain?.account.accountId ??
              (mainInPool ? undefined : authWithAccount.accountId) ??
              (primaryAccess
                ? extractAccountIdFromClaims(
                    parseJwtClaims(primaryAccess) ?? {},
                  )
                : undefined)
            if (myGeneration === mainIdentityGeneration) {
              currentMainIdentity = mainAccountIdentity
            }
            const mode: RoutingMode = reqStorage?.routing?.mode ?? 'main-first'
            // One shared sidebar snapshot per request: admission decisions for
            // main and the fallbacks must all judge the same snapshot. It comes
            // from the cache and never waits on the sidebar lock.
            const sidebarSnapshot = await sidebarCache.get()
            const sidebarState = sidebarSnapshot.state

            if (
              mode === 'sticky-balanced' &&
              sidebarSessionId &&
              isReplayableRequest(requestInput, init) &&
              typeof init?.body === 'string'
            ) {
              const requestBytes = Buffer.byteLength(init.body, 'utf8')
              const stickyRoster = await buildStickyRouteRoster({
                storage: fallbackStorage,
                sidebarState,
                primaryAccess,
                mainAccountIdentity,
                mainUnavailable,
              })
              let stickyCandidate = resolveStickyRouteCandidate({
                sessionId: sidebarSessionId,
                requestBytes,
                candidates: stickyRoster,
                sidebarSnapshot,
                now: Date.now(),
              })

              if (stickyCandidate) {
                const preSendBreak = isStickyRouteCandidateRateLimited(
                  stickyCandidate,
                )
                  ? { action: 'migrate' as const, reason: 'exhausted' as const }
                  : stickyBreakDecision(
                      stickyCandidate,
                      sidebarState,
                      undefined,
                      Date.now(),
                      reqStorage,
                    )
                if (preSendBreak.action === 'migrate') {
                  const replacement = resolveStickyRouteCandidate({
                    sessionId: sidebarSessionId,
                    requestBytes,
                    candidates: stickyRoster,
                    sidebarSnapshot,
                    excludeAccountIds: [stickyCandidate.accountId],
                    now: Date.now(),
                  })
                  if (replacement) {
                    logA.debug('sticky routing: migrated session pin', {
                      pid: process.pid,
                      sessionHash: hashSidebarSessionId(sidebarSessionId),
                      fromAccountId: stickyCandidate.accountId,
                      toAccountId: replacement.accountId,
                      reason: preSendBreak.reason,
                    })
                    stickyCandidate = replacement
                  }
                }

                let stickyResponse = await sendWithAccessToken(
                  requestInput,
                  init,
                  stickyCandidate.access,
                  stickyCandidate.wireAccountId,
                  stickyCandidate.keepwarmAccountKey,
                )

                const pushStickyQuota = (
                  response: Response,
                  candidate: StickyRouteCandidate,
                ) => {
                  try {
                    const snapshot = normalizeQuotaHeaders(response.headers)
                    pushQuota(
                      snapshot as Record<string, unknown>,
                      candidate.access,
                      candidate.accountId === 'main'
                        ? undefined
                        : candidate.accountId,
                      candidate.accountId === 'main'
                        ? candidate.wireAccountId
                        : undefined,
                      isCompleteQuotaHeaderFrame(response.headers),
                    )
                  } catch {
                    // Quota push is advisory; preserve the provider response.
                  }
                }

                pushStickyQuota(stickyResponse, stickyCandidate)
                const responseBreak = stickyBreakDecision(
                  stickyCandidate,
                  sidebarState,
                  stickyResponse.status,
                  Date.now(),
                  reqStorage,
                )
                const retryableStickyFailure =
                  stickyResponse.status === 401 ||
                  stickyResponse.status === 403 ||
                  stickyResponse.status === 429
                if (
                  retryableStickyFailure &&
                  responseBreak.action === 'migrate'
                ) {
                  const replacement = resolveStickyRouteCandidate({
                    sessionId: sidebarSessionId,
                    requestBytes,
                    candidates: stickyRoster,
                    sidebarSnapshot,
                    excludeAccountIds: [stickyCandidate.accountId],
                    now: Date.now(),
                  })
                  if (replacement) {
                    logA.debug('sticky routing: migrated session pin', {
                      pid: process.pid,
                      sessionHash: hashSidebarSessionId(sidebarSessionId),
                      fromAccountId: stickyCandidate.accountId,
                      toAccountId: replacement.accountId,
                      reason: responseBreak.reason,
                    })
                    const previousResponse = stickyResponse
                    stickyResponse = await sendWithAccessToken(
                      requestInput,
                      init,
                      replacement.access,
                      replacement.wireAccountId,
                      replacement.keepwarmAccountKey,
                    )
                    previousResponse.body?.cancel().catch(() => {})
                    stickyCandidate = replacement
                    pushStickyQuota(stickyResponse, stickyCandidate)
                  }
                }

                if (
                  stickyCandidate.fallback &&
                  !shouldFallbackStatus(stickyResponse.status, reqStorage)
                ) {
                  // See the fallback-first path above: telemetry only, never
                  // awaited on the request path.
                  void fallbackManager.markUsed(stickyCandidate.fallback)
                }
                queueRequestSidebarRouting(
                  sidebarSessionId,
                  sidebarParentSessionId,
                  stickyCandidate.accountId,
                  mode,
                  reqStorage?.accounts,
                  applyStickyPinOverlay(sidebarSnapshot, stickyPinOverlay),
                )
                return stickyResponse
              }
            }

            const mainQuotaDecision = admissionQuotaDecision(
              quotaManager.peekMainForPolicy(mainAccountIdentity),
              sidebarState.main.quota,
              Date.now(),
              sidebarState.main.mainAccountId,
              mainAccountIdentity,
            )
            const killswitchBlocksMain =
              isKillswitchEnabled(reqStorage) &&
              !killswitchPassesPolicy(
                killswitchMainQuota(mainAccountIdentity),
                reqStorage,
                undefined,
                Date.now(),
              )
            const mainRateLimited = quotaManager.isRateLimited('main')
            let fallbackSelectionPromise:
              | Promise<FallbackCandidateSelection>
              | undefined
            const requestFallbackSelection = () => {
              fallbackSelectionPromise ??= usableFallbackCandidates(
                fallbackStorage,
                sidebarState,
              )
              return fallbackSelectionPromise
            }

            // fallback-first (proactive): try usable fallbacks BEFORE main. If one
            // serves, use it and skip main entirely; otherwise fall through to the
            // main send below. Only replayable requests can be routed to a
            // fallback (the body must survive a re-send).
            let response: Response | undefined
            let servedFallback:
              | { accessToken: string; accountId?: string; activeId: string }
              | undefined
            // True when the proactive gate already tried every usable fallback,
            // so the reactive path below must not re-try (and re-spend on) them.
            let fallbacksAlreadyTried = false
            let fallbackCandidates: FallbackCandidate[] | undefined
            if (
              mode === 'fallback-first' &&
              isReplayableRequest(requestInput, init)
            ) {
              fallbacksAlreadyTried = true
              const selection = await requestFallbackSelection()
              fallbackCandidates = applyAdmissionQuotaSafety(
                selection,
                !killswitchBlocksMain &&
                  !mainRateLimited &&
                  !mainQuotaDecision.exhausted,
              )
              const pre = await tryFallbackFirst(
                requestInput,
                init,
                reqStorage,
                fallbackCandidates,
              )
              if (pre) {
                response = pre.response
                servedFallback = {
                  accessToken: pre.accessToken,
                  accountId: pre.quotaAccountId,
                  activeId: pre.activeId,
                }
              }
            }

            // Killswitch (opt-in): act on last-seen cached quota, push-only — no
            // network fetch on the hot path. If main is below its threshold, do
            // NOT spend on it: synthesize a 429 so the reactive-fallback path can
            // reroute to a surviving account, and if none survive (or the body is
            // non-replayable so a fallback is impossible) the 429 stands as the
            // hard block (with a Retry-After). Blocking is independent of
            // replayability — the killswitch's contract is "never spend below
            // threshold", so a non-replayable request hard-fails.
            //
            // Same treatment for a mid-stream rate-limit mark (a prior request on
            // main hit response.failed/rate_limit_reached_type on the WS
            // transport): main is exhausted right now even though the killswitch's
            // cached quota may not yet reflect it, so block main here too until
            // the mark's reset passes.
            if (!response) {
              // Admission: a main the shared data already knows to be exhausted
              // is blocked only when the request is replayable AND a
              // non-exhausted fallback survives to serve. Otherwise the probe
              // stands — blocking a non-replayable request with no usable
              // fallback would be a hard denial with no wire check anywhere in
              // the request, so the wire gets the final say.
              const quotaBlocksMain =
                mainQuotaDecision.exhausted &&
                isReplayableRequest(requestInput, init) &&
                (await requestFallbackSelection()).retained.length > 0
              if (killswitchBlocksMain || mainRateLimited || quotaBlocksMain) {
                const blockReason = killswitchBlocksMain
                  ? 'killswitch'
                  : mainRateLimited
                    ? 'mid-stream-rate-limit'
                    : 'quota-exhausted'
                if (
                  blockReason === 'quota-exhausted' &&
                  mainQuotaDecision.exhausted
                ) {
                  logAdmissionQuotaSkip('main', mainQuotaDecision)
                }
                logA.debug('admission blocked primary', {
                  pid: process.pid,
                  activeId: 'main',
                  reason: blockReason,
                })
                response = killswitchBlockedResponse(
                  reqStorage,
                  blockReason,
                  blockReason === 'quota-exhausted' &&
                    mainQuotaDecision.exhausted
                    ? mainQuotaDecision.resetAtMs
                    : mainRateLimited
                      ? quotaManager.rateLimitedUntil('main')
                      : undefined,
                )
              } else {
                // Send through the main account.
                response = mainUnavailable
                  ? new Response(null, { status: 401 })
                  : await sendWithAccessToken(
                      requestInput,
                      init,
                      primaryAccess,
                      mainAccountIdentity,
                      'main',
                    )
              }
            }

            // A fallback served proactively (fallback-first) — attribute quota
            // to it and mark it the display-active account. Its response is a
            // success, so no reactive retry is needed.
            let fallbackServed = Boolean(servedFallback)
            let finalResponse = response
            let fallbackQuotaAccess =
              servedFallback?.accessToken ?? primaryAccess
            let fallbackQuotaAccountId = servedFallback?.accountId
            let servedActiveId = servedFallback?.activeId ?? 'main'

            // main-first (or fallback-first that fell through to main): on a
            // 401/403/429 from main, reactively try usable fallbacks — unless the
            // proactive gate already tried them all (fallback-first), in which
            // case re-trying would just re-spend on the same exhausted accounts.
            if (
              !servedFallback &&
              !fallbacksAlreadyTried &&
              shouldFallbackStatus(response.status, reqStorage)
            ) {
              logA.debug('reactive fallback triggered', {
                pid: process.pid,
                status: response.status,
              })
              // Main already failed, so it is no longer a surviving candidate
              // for the admission safety valve.
              fallbackCandidates ??= applyAdmissionQuotaSafety(
                await requestFallbackSelection(),
                false,
              )
              const fallbackResult = await tryFallbackAccounts(
                requestInput,
                init,
                response,
                reqStorage,
                fallbackCandidates,
              )
              const fallbackResponse = fallbackResult.response
              if (fallbackResponse !== response) {
                fallbackServed = true
                finalResponse = fallbackResponse
                fallbackQuotaAccess =
                  fallbackResult.accessToken ?? primaryAccess
                fallbackQuotaAccountId = fallbackResult.accountId
                if (fallbackResult.accountId)
                  servedActiveId = fallbackResult.accountId
              }
            }

            // A transfer may have filled main while this request waited for
            // its refresh lock. The original snapshot can still lack the row,
            // so a token resolved from the newer snapshot counts as available.
            if (
              mainInPool &&
              mainUnavailable &&
              !fallbackServed &&
              (await poolPlaceholderWithoutMain(
                getAccountPaths(getConfigPath()),
                await getAuth(),
              ))
            )
              throw new Error(POOL_LOGIN_REQUIRED_MESSAGE)

            try {
              const snapshot = normalizeQuotaHeaders(finalResponse.headers)
              if (fallbackServed) {
                pushQuota(
                  snapshot as Record<string, unknown>,
                  fallbackQuotaAccess,
                  fallbackQuotaAccountId,
                  undefined,
                  isCompleteQuotaHeaderFrame(finalResponse.headers),
                )
              } else {
                pushQuota(
                  snapshot as Record<string, unknown>,
                  primaryAccess,
                  undefined,
                  mainAccountIdentity,
                  isCompleteQuotaHeaderFrame(finalResponse.headers),
                )
              }
            } catch {
              // Quota push is best-effort — never break the response
            }

            queueRequestSidebarRouting(
              sidebarSessionId,
              sidebarParentSessionId,
              servedActiveId,
              mode,
              reqStorage?.accounts,
              applyStickyPinOverlay(sidebarSnapshot, stickyPinOverlay),
            )
            return finalResponse
          },
        }
      },
      methods: loginAuthMethods,
    },
    'chat.headers': async (input, output) => {
      if (input.model.providerID !== 'openai') return
      output.headers.originator = 'opencode'
      output.headers['User-Agent'] =
        `${buildUserAgent(PackageVersion)} (${os.platform()} ${os.release()}; ${os.arch()})`
      output.headers['session-id'] = input.sessionID
      // Only our Codex fetch removes the agent header; API-key requests use the
      // host's fetch instead and must never receive this internal header.
      if (codexFetchInstalled) output.headers[OPENAI_AGENT_HEADER] = input.agent
      // Temporary fetch-layer hack: title generation currently shares the conversation
      // session ID, so the OpenAI plugin marks it for HTTP fallback until transport
      // context can be passed directly instead of smuggled through headers.
      if (websocketFetchInstalled && input.agent === 'title')
        output.headers[OpenAIWebSocketPool.TITLE_HEADER] = 'true'
    },
    'chat.params': async (input, output) => {
      if (input.model.providerID !== 'openai') return
      // Match codex cli
      output.maxOutputTokens = undefined
    },
    config: async (config: { command?: Record<string, unknown> }) => {
      createLogger('commands').info('registering commands', {
        existing: Object.keys(config.command ?? {}).length,
        pid: process.pid,
      })
      config.command = {
        ...(config.command ?? {}),
        [OPENAI_COMMAND_NAME]: {
          template: OPENAI_COMMAND_NAME,
          description:
            'OpenAI accounts: quota, routing, limits, cache keep-warm, diagnostics and reset credits.',
        },
      }
    },
    'command.execute.before': async (input: {
      command: string
      arguments: string
      sessionID: string
    }) => {
      createLogger('commands').info('command hook entered', {
        command: input.command,
        hasCmdCtx: cmdCtx !== null,
        pid: process.pid,
      })
      if (input.command !== OPENAI_COMMAND_NAME) return
      if (!cmdCtx) {
        createLogger('commands').warn('command rejected: context not loaded', {
          command: input.command,
          pid: process.pid,
        })
        await sendIgnoredMessage(
          input.sessionID,
          'OpenAI auth plugin is still initializing. Send a request first, then try again.',
        )
        cleanAbort()
      }
      // biome-ignore lint/style/noNonNullAssertion: guarded above (cleanAbort throws when cmdCtx is null)
      const payload = await openOpenAiMenu(cmdCtx!, input.sessionID)
      if (isTuiConnected(input.sessionID)) {
        pushNotification(payload, input.sessionID)
      } else {
        await sendIgnoredMessage(input.sessionID, menuText(payload.menu))
      }
      cleanAbort()
    },
  }
}

export const OpenAIAuthPlugin: Plugin = async (input) => {
  const settings = getSettings()
  return CodexAuthPlugin(input, {
    codexApiEndpoint: settings.codexApiEndpoint,
    experimentalWebSockets: settings.webSockets,
    responsesLite: settings.responsesLite,
  })
}

export default {
  id: 'cortexkit-openai-auth',
  server: OpenAIAuthPlugin,
}
