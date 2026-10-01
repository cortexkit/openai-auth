/**
 * The `/openai` command: one menu for accounts, quota, routing, limits, the
 * cache, diagnostics and the provider extras, built on the shared command
 * menu (`@cortexkit/common-auth/commands`). Both hosts build their menu with
 * `createOpenAiMenu`; each supplies what only it has (OpenCode its cache
 * keep-warm manager and dumps, Pi its own login and pool; both their
 * connection to the Claustrum vault).
 *
 * The menu works on the account pool, so it needs a migrated install. Until
 * then `/openai` shows only why (`migrationNoticeMenu`).
 *
 * Every settings write the menu makes goes through the pool store's
 * `updateSettings`. On the way, `withSettingsMigration` moves settings this
 * plugin wrote under an older name or meaning into the shared vocabulary.
 */
import {
  type AccountsSectionOptions,
  type CommandApplyRequest,
  type CommandApplyResult,
  type CommandDialogPayload,
  type CommandInvocation,
  type CommandMenu,
  type CommandMenuModel,
  createCommandMenu,
  type PluginExtraSection,
  type PluginSection,
  type SeamLogger,
} from '@cortexkit/common-auth/commands'
import type {
  AddInput,
  PoolLockSpec,
  PoolStore,
  RemoveOptions,
} from '@cortexkit/common-auth/store'
import {
  type AccountStorage,
  DEFAULT_KILLSWITCH_THRESHOLDS,
  type loadAccounts as defaultLoadAccounts,
  type mutateAccounts as defaultMutateAccounts,
  getKillswitchThresholdsForAccount,
  isSafeResetAccountKey,
  KILLSWITCH_FLOORS_SCHEMA,
} from './accounts'
import { createLogger } from './logger'
import type { IngestAccount } from './oauth'
import { whamUsageFn } from './provider'
import type { QuotaManager } from './quota-manager'
import type { RefreshAllQuotaResult } from './refresh-all-quota'
import {
  countEligibleResetCredits,
  evaluateResetPrecondition,
  listResetCredits,
  ResetCreditError,
  ResetRedemptionError,
  type RunResetCreditResult,
  resetWindowIsExhausted,
  runResetCreditRedemption,
  selectCreditToSpend,
} from './reset-credits'
import { isRecord } from './util/record.ts'
import {
  type OpenAiVault,
  vaultApprovalInstructions,
  vaultConnectOutcome,
  vaultEnrollmentLine,
} from './vault'

/** The one slash command, without the slash. */
export const OPENAI_COMMAND_NAME = 'openai'

/** The menu's title, shown by both hosts. */
export const OPENAI_MENU_TITLE = 'OpenAI accounts'

/** The row the main account lives in once the install is migrated. */
const MAIN_ROW_ID = 'main'

const log = createLogger('commands')

/**
 * The prompt-cache manager, as the Cache section uses it.
 *
 * Declared structurally rather than imported: the manager itself is tied to
 * one host's live request loader and stays there. Only the members the Cache
 * section and the host's session cleanup reach appear here.
 */
export interface CacheKeepManager {
  status(): {
    running: boolean
    sustain: boolean
    window?: { startHour: number; endHour: number } | undefined
    tracked: number
    generatedAt: number
    ttlMs: number
    leadMs: number
    maxIdleWarmMs: number
    maxSubagentIdleMs: number
    targets: ReadonlyArray<{
      sessionKey: string
      accountId?: string
      cacheExpiresAt: number
      lastWarmedAt?: number
      backoffUntil?: number
    }>
  }
  start(): void
  stop(): void
  remove(sessionKey: string): void
}

export interface ResetTargetIdentity {
  accountKey: string
  label: string
  accessToken: string
  chatgptAccountId?: string
  onAuthFailure?: (status: number) => Promise<void>
}

// ---------------------------------------------------------------------------
// Settings vocabulary
// ---------------------------------------------------------------------------

type Settings = Record<string, unknown>

/** Ids an object literal cannot hold as plain keys. */
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * The killswitch block `block` (an older, unmarked one) rewritten as
 * per-account floors in the shared vocabulary.
 *
 * Every account the block can apply to gets, per window, exactly the floor
 * the older reader applied to it: its own thresholds when it had an entry,
 * else the `main` thresholds, and the default for a window neither names.
 * The main account (judged against `main`) becomes row `main`. Accounts the
 * older reader covered implicitly are written explicitly, because in the new
 * vocabulary an account without an entry has no floor. The same quota
 * therefore blocks the same requests before and after.
 */
export function killswitchInFloors(
  block: Record<string, unknown>,
  rosterIds: readonly string[],
): Settings {
  // The older reader, run on the older block, is the definition of what the
  // floors were; asking it keeps the mapping exact by construction.
  const legacy = {
    version: 1,
    accounts: [],
    killswitch: block,
  } as unknown as AccountStorage
  const named = isRecord(block.accounts) ? Object.keys(block.accounts) : []
  const accounts: Record<string, { primary: number; secondary: number }> = {}
  for (const id of new Set([MAIN_ROW_ID, ...rosterIds, ...named])) {
    if (PROTOTYPE_KEYS.has(id)) continue
    const floors = getKillswitchThresholdsForAccount(
      legacy,
      id === MAIN_ROW_ID ? undefined : id,
    )
    accounts[id] = { primary: floors.primary, secondary: floors.secondary }
  }
  const next: Settings = { ...block }
  delete next.main
  next.accounts = accounts
  next.schema = KILLSWITCH_FLOORS_SCHEMA
  return next
}

/**
 * A killswitch block created in the shared vocabulary, marked as such, with
 * the default floors (`DEFAULT_KILLSWITCH_THRESHOLDS`) written for row
 * `main` and every row in `rosterIds` the block does not name. Floors the
 * block already holds are kept as they are.
 */
export function killswitchWithDefaultFloors(
  block: Record<string, unknown>,
  rosterIds: readonly string[],
): Settings {
  const accounts: Record<string, unknown> = isRecord(block.accounts)
    ? { ...block.accounts }
    : {}
  for (const id of new Set([MAIN_ROW_ID, ...rosterIds])) {
    if (PROTOTYPE_KEYS.has(id) || Object.hasOwn(accounts, id)) continue
    accounts[id] = {
      primary: DEFAULT_KILLSWITCH_THRESHOLDS.primary,
      secondary: DEFAULT_KILLSWITCH_THRESHOLDS.secondary,
    }
  }
  return { ...block, accounts, schema: KILLSWITCH_FLOORS_SCHEMA }
}

/**
 * Moves the settings this plugin wrote under an older name or meaning into
 * the shared vocabulary, in place. True when anything changed.
 *
 * - `cachekeep` becomes `cacheKeep`; a value already under the new name wins.
 * - An unmarked killswitch block becomes per-account floors
 *   (`killswitchInFloors`) for the rows in `rosterIds`.
 *
 * `routing.mode` and `logging.level` already have the shared names.
 */
export function migrateLegacySettings(
  settings: Settings,
  rosterIds: readonly string[],
): boolean {
  let changed = false
  if (isRecord(settings.cachekeep)) {
    settings.cacheKeep = {
      ...settings.cachekeep,
      ...(isRecord(settings.cacheKeep) ? settings.cacheKeep : {}),
    }
    delete settings.cachekeep
    changed = true
  }
  const killswitch = settings.killswitch
  if (isRecord(killswitch) && killswitch.schema !== KILLSWITCH_FLOORS_SCHEMA) {
    settings.killswitch = killswitchInFloors(killswitch, rosterIds)
    changed = true
  }
  return changed
}

async function rosterIdsOf(store: PoolStore): Promise<string[]> {
  const load = await store.read()
  return load.status === 'ready' ? load.rows.map((row) => row.id) : []
}

/**
 * The store with its settings seen, and written, in the shared vocabulary.
 *
 * `readSettings` returns the settings as `migrateLegacySettings` would leave
 * them, without writing. `updateSettings` migrates the stored settings in
 * the same locked write as the caller's change, before the caller sees them
 * (so its edit applies to the new shape), and gives a killswitch block the
 * caller created the default floors (`killswitchWithDefaultFloors`).
 * Every other member is the store's own.
 *
 * The roster is read just before the locked write; a row added in between
 * gets no killswitch floors from the migration.
 */
export function withSettingsMigration(store: PoolStore): PoolStore {
  const readSettings: PoolStore['readSettings'] = async () => {
    const read = await store.readSettings()
    if (read.status === 'error') return read
    const settings = structuredClone(read.settings)
    migrateLegacySettings(settings, await rosterIdsOf(store))
    return { ...read, settings }
  }
  const updateSettings: PoolStore['updateSettings'] = async (
    mutator,
    options,
  ) => {
    const ids = await rosterIdsOf(store)
    return store.updateSettings(async (settings) => {
      migrateLegacySettings(settings, ids)
      const next = (await mutator(settings)) ?? settings
      // Every block that existed was given `schema: KILLSWITCH_FLOORS_SCHEMA`
      // above, so one without it was created by this write (turning the killswitch on, or setting a first
      // floor). Every account it does not name gets the default floors, as
      // turning the killswitch on always did, so enabling it protects every
      // account rather than none.
      if (
        isRecord(next.killswitch) &&
        next.killswitch.schema !== KILLSWITCH_FLOORS_SCHEMA
      )
        next.killswitch = killswitchWithDefaultFloors(next.killswitch, ids)
      return next
    }, options)
  }
  return new Proxy(store, {
    get(target, property) {
      if (property === 'readSettings') return readSettings
      if (property === 'updateSettings') return updateSettings
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

export interface AccountRules {
  /**
   * The legacy locks a write of row `id` holds besides the store's own: the
   * locks an older openai-auth process holds while it refreshes that row.
   * Taken by remove, enable, disable and replace (and by the replace a
   * re-login becomes).
   */
  rowLocks?(id: string): readonly PoolLockSpec[]
}

/**
 * The store with openai-auth's rules for row writes:
 *
 * - remove, enable, disable and replace take `rowLocks(id)`;
 * - an add of a login whose ChatGPT identity (or, failing that, whose id) an
 *   OAuth row already holds replaces that row's credential instead of adding
 *   a disabled duplicate: signing in again refreshes the account. A login of
 *   the ChatGPT account in row `main` is refused; it is OpenCode's own
 *   sign-in.
 *
 * Every other member is the store's own.
 */
export function withAccountRules(
  store: PoolStore,
  rules: AccountRules,
): PoolStore {
  const locksFor = (id: string, given?: readonly PoolLockSpec[]) =>
    rules.rowLocks ? rules.rowLocks(id) : given
  const withLocks = <T extends { extraLocks?: readonly PoolLockSpec[] }>(
    id: string,
    options: T | undefined,
  ): T => {
    const extraLocks = locksFor(id, options?.extraLocks)
    return { ...(options ?? ({} as T)), ...(extraLocks ? { extraLocks } : {}) }
  }
  const replace: PoolStore['replace'] = (id, credential, identity, options) =>
    store.replace(id, credential, identity, withLocks(id, options))
  const add: PoolStore['add'] = async (input, options) => {
    const load = await store.read()
    const rows = load.status === 'ready' ? load.rows : []
    const oauth = rows.filter((row) => row.type === 'oauth' && !row.invalid)
    const sameAccount = input.identity
      ? oauth.find((row) => row.identity === input.identity)
      : undefined
    if (sameAccount?.id === MAIN_ROW_ID)
      throw new Error(
        'that account is already your main account, so it was not added again',
      )
    const existing =
      sameAccount ??
      oauth.find((row) => row.id === input.id && row.id !== MAIN_ROW_ID)
    if (!existing || input.credential.type !== 'oauth')
      return store.add(input, options)
    const replaced = await replace(
      existing.id,
      input.credential,
      input.identity !== undefined ? { identity: input.identity } : {},
      options?.extraLocks ? { extraLocks: options.extraLocks } : undefined,
    )
    log.info('account signed in again', { id: existing.id })
    return {
      id: replaced.id,
      outcome: 'rotated',
      credential: replaced.credential,
    }
  }
  const enable: PoolStore['enable'] = (id, options) =>
    store.enable(id, withLocks(id, options))
  const members: Partial<Record<keyof PoolStore, unknown>> = {
    add,
    replace,
    enable,
    disable: ((id, reason, options) =>
      store.disable(
        id,
        reason,
        withLocks(id, options),
      )) as PoolStore['disable'],
    remove: ((id, options) =>
      store.remove(id, withLocks(id, options))) as PoolStore['remove'],
  }
  return new Proxy(store, {
    get(target, property) {
      if (Object.hasOwn(members, property))
        return members[property as keyof PoolStore]
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

/** One settings write through the store, in the shared vocabulary. */
export async function writeSettings(
  store: PoolStore,
  extraLocks: readonly PoolLockSpec[] | undefined,
  edit: (settings: Settings) => void,
): Promise<void> {
  await withSettingsMigration(store).updateSettings(
    (settings) => {
      edit(settings)
      return undefined
    },
    extraLocks ? { extraLocks } : {},
  )
}

/** The config keys the pool owns; a settings write never sets them. */
const POOL_OWNED = ['version', 'accounts', 'commonAuthPool'] as const

/**
 * A `mutateAccounts` for code that edits only settings keys (the reset-credit
 * coordinator), writing through the store's `updateSettings` instead of
 * rewriting the account files. The mutator sees the settings with an empty
 * account list; the pool-owned keys of its result are dropped, so it cannot
 * change the roster.
 */
export function settingsMutateAccounts(
  store: PoolStore,
  extraLocks: readonly PoolLockSpec[] | undefined,
): typeof defaultMutateAccounts {
  return async (mutate) => {
    let view: AccountStorage | undefined
    await withSettingsMigration(store).updateSettings(
      (settings) => {
        const current = {
          ...settings,
          version: 1,
          accounts: [],
        } as unknown as AccountStorage
        const next = mutate(current) ?? current
        view = next
        const out: Settings = { ...(next as unknown as Settings) }
        for (const key of POOL_OWNED) delete out[key]
        return out
      },
      extraLocks ? { extraLocks } : {},
    )
    if (!view) throw new Error('the settings write did not run')
    return view
  }
}

// ---------------------------------------------------------------------------
// The not-migrated notice
// ---------------------------------------------------------------------------

/** One live process, on an older version, that keeps the accounts from moving to the account pool. */
export interface MigrationBlocker {
  /** `'unknown'` when the directory of process heartbeats could not be read. */
  pid: number | 'unknown'
  version: string
}

export type MenuMigrationState =
  | { migrated: true }
  | { migrated: false; blockers: readonly MigrationBlocker[] }

/** The id of the notice's one section. */
export const MIGRATION_NOTICE_SECTION_ID = 'migration'

/** What `/openai` shows on an install that has not migrated: one section. */
export function migrationNoticeMenu(
  blockers: readonly MigrationBlocker[],
): CommandMenuModel {
  const lines = [
    'Accounts move to the new account layout once every OpenCode process on this machine runs this version of OpenAI auth. This menu works on that layout, so it opens after the move.',
    blockers.length > 0
      ? 'These processes still hold the move back:'
      : 'No running process holds the move back.',
  ]
  const menu: CommandMenuModel = {
    command: OPENAI_COMMAND_NAME,
    title: OPENAI_MENU_TITLE,
    sections: [
      {
        id: MIGRATION_NOTICE_SECTION_ID,
        slot: 'extra',
        title: 'Accounts are moving',
        lines,
        items: blockers.map((blocker, index) => ({
          id: `blocker-${index}`,
          label:
            blocker.pid === 'unknown'
              ? 'processes that could not be read'
              : `pid ${blocker.pid}`,
          detail: `version ${blocker.version}`,
          actions: [],
        })),
        actions: [],
      },
    ],
  }
  return scrubMenu(menu)
}

/**
 * Credential-shaped property names: names ending in `token`, `key` or
 * `secret`, and the stored credential fields. The shared seam drops the same
 * names from every payload it builds; this list covers the one payload built
 * here, the notice.
 */
const CREDENTIAL_KEYS = new Set([
  'access',
  'refresh',
  'apikey',
  'authheader',
  'password',
  'credential',
  'credentials',
])

function isCredentialKey(key: string) {
  const normalized = key.toLowerCase().replace(/[-_]/g, '')
  if (CREDENTIAL_KEYS.has(normalized)) return true
  return (
    normalized.endsWith('token') ||
    normalized.endsWith('key') ||
    normalized.endsWith('secret')
  )
}

/**
 * Strips credential-shaped fields from a value bound for the RPC boundary,
 * recording the path of each one dropped in `found` (names only, never
 * values). Recurses into nested objects and arrays.
 */
export function scrubKnobs(
  value: unknown,
  path: string,
  found: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((entry, index) =>
      scrubKnobs(entry, `${path}[${index}]`, found),
    )
  }
  if (!isRecord(value)) return value
  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isCredentialKey(key)) {
      found.push(`${path}.${key}`)
      continue
    }
    result[key] = scrubKnobs(entry, `${path}.${key}`, found)
  }
  return result
}

function scrubMenu(menu: CommandMenuModel): CommandMenuModel {
  const found: string[] = []
  const scrubbed = scrubKnobs(menu, 'menu', found) as CommandMenuModel
  if (found.length > 0)
    log.warn('credential-shaped field stripped before RPC', { fields: found })
  return scrubbed
}

// ---------------------------------------------------------------------------
// Accounts: the login
// ---------------------------------------------------------------------------

/** A started OAuth login, as `beginAccountLogin` returns it. */
export interface MenuLoginFlow {
  url: string
  instructions: string
  completion: Promise<IngestAccount>
}

export interface MenuLoginDeps {
  /** Starts a browser login, or a device-code login when `headless`. */
  begin(options: { label?: string; headless: boolean }): Promise<MenuLoginFlow>
  /** The main account's ChatGPT identity; a login of that account is refused. */
  mainIdentity?(): Promise<string | undefined>
}

/** The pool row a finished login becomes. */
export function loginAddInput(account: IngestAccount): AddInput {
  return {
    id: account.id,
    credential: {
      type: 'oauth',
      refresh: account.refresh,
      ...(account.access !== undefined ? { access: account.access } : {}),
      ...(account.expires !== undefined ? { expires: account.expires } : {}),
    },
    ...(account.accountId !== undefined ? { identity: account.accountId } : {}),
    ...(account.label !== undefined ? { label: account.label } : {}),
  }
}

/** The Accounts section's add action, over this plugin's OAuth login. */
export function menuLogin(
  deps: MenuLoginDeps,
): NonNullable<AccountsSectionOptions['login']> {
  return {
    label: 'Add account',
    knobs: [
      { kind: 'text', id: 'label', label: 'Label (optional)' },
      {
        kind: 'toggle',
        id: 'headless',
        label: 'Sign in with a device code (no browser on this machine)',
        value: false,
      },
    ],
    run: async (values) => {
      const label =
        typeof values.label === 'string' && values.label.trim().length > 0
          ? values.label.trim()
          : undefined
      const headless = values.headless === true
      const flow = await deps.begin({
        ...(label !== undefined ? { label } : {}),
        headless,
      })
      const message = headless
        ? `Open this verification URL:\n\n${flow.url}\n\nThen enter the code: ${flow.instructions.match(/Enter code: (.+)/)?.[1] ?? flow.instructions}\n\nThe account is added when you finish.`
        : `Open this URL and complete sign-in:\n\n${flow.url}\n\n${flow.instructions}\n\nThe account is added when you finish.`
      const completion = flow.completion.then(async (account) => {
        const main = await deps.mainIdentity?.()
        if (account.accountId && main && account.accountId === main) {
          // The internal id only: the ChatGPT identity is sensitive.
          log.warn('account add rejected (main identity)', { id: account.id })
          throw new Error(
            'that account is already your main account, so it was not added again',
          )
        }
        log.info('account added', { id: account.id })
        return loginAddInput(account)
      })
      return { status: 'pending', message, completion }
    },
  }
}

// ---------------------------------------------------------------------------
// Provider extras
// ---------------------------------------------------------------------------

export interface SessionSectionDeps {
  /** The session's sticky pin, when sticky-balanced routing has one. */
  getPin?(sessionId: string): Promise<string | undefined>
  /** Clears the session's pin only; the account rows are not touched. */
  clearPin?(sessionId: string): Promise<unknown>
}

/** This session's sticky routing pin, and clearing it. */
export function sessionSection(deps: SessionSectionDeps): PluginExtraSection {
  return {
    id: 'session',
    title: 'This session',
    build: async (invocation) => {
      const sessionId = invocation.sessionId
      if (!sessionId) return { lines: ['No current session.'] }
      const pin = await deps.getPin?.(sessionId)
      return {
        lines: [
          pin
            ? `Sticky routing pins this session to ${pin}.`
            : 'This session has no sticky routing pin.',
        ],
        actions: deps.clearPin
          ? [
              {
                id: 'clear-pin',
                label: "Clear this session's pin",
                description:
                  'The next request may still choose the same account.',
                run: async ({ invocation: current }) => {
                  if (!current.sessionId) return 'No current session.'
                  await deps.clearPin?.(current.sessionId)
                  log.info('routing session pin cleared')
                  return "This session's pin was cleared. The next request may choose the same account if it remains the best selection."
                },
              },
            ]
          : [],
      }
    },
  }
}

export interface VaultSectionDeps {
  vault: Pick<
    OpenAiVault,
    | 'name'
    | 'status'
    | 'connectStep'
    | 'waitForApproval'
    | 'disconnect'
    | 'decline'
    | 'accept'
    | 'routes'
    | 'snapshot'
  >
  /** Runs after a change to which vault accounts route (the host re-reads them). */
  changed?(): unknown
}

/**
 * The Claustrum vault: whether this host is connected, the OpenAI accounts
 * the vault serves it, Connect (enrollment, approved by the operator with
 * `ck`), Disconnect (forget this host's token), and enabling or disabling
 * each vault account here (a disabled one is declined: it stays listed and
 * never routes).
 */
export function vaultSection(deps: VaultSectionDeps): PluginExtraSection {
  const { vault } = deps
  return {
    id: 'vault',
    title: 'Vault',
    build: async () => {
      const status = await vault.status()
      const connected = status.enrollment.state === 'approved'
      const routing = vault.routes().length
      return {
        lines: [
          vaultEnrollmentLine(status.host, status.name, status.enrollment),
          ...vaultApprovalInstructions(status.name, status.enrollment),
          ...(connected
            ? [
                status.accounts.length === 0
                  ? 'The vault serves no OpenAI account to this host yet.'
                  : `The vault serves ${status.accounts.length} OpenAI account${status.accounts.length === 1 ? '' : 's'}; ${routing} can route now.`,
              ]
            : []),
          ...(status.lastError ? [`Last error: ${status.lastError}`] : []),
        ],
        items: status.accounts.map((row) => ({
          id: row.routeId,
          label: row.label,
          detail: [
            row.credentialType === 'api_key' ? 'API key' : 'login',
            row.state === 'active' ? 'active' : `vault state ${row.state}`,
            row.enabled ? 'enabled' : 'disabled here',
          ].join(', '),
          actions: [
            row.enabled
              ? {
                  id: 'disable',
                  label: 'Disable on this host',
                  description:
                    'It stays in the vault and in this list, and is never sent from this host until enabled again.',
                  run: async () => {
                    await vault.decline(row.routeId)
                    await deps.changed?.()
                    return `${row.label} is disabled on this host.`
                  },
                }
              : {
                  id: 'enable',
                  label: 'Enable on this host',
                  run: async () => {
                    await vault.accept(row.routeId)
                    await deps.changed?.()
                    return `${row.label} is enabled on this host.`
                  },
                },
          ],
        })),
        actions: connected
          ? [
              {
                id: 'disconnect',
                label: 'Disconnect',
                description:
                  'Forgets this host\'s vault token; its vault accounts stop routing at once. Revoke the enrollment itself with `ck auth enroll revoke`.',
                confirm:
                  'Disconnect from the vault? Connecting again needs a new approval with `ck`.',
                run: async () => {
                  await vault.disconnect()
                  await deps.changed?.()
                  return `Disconnected: ${vault.name} no longer reads from the vault. Run \`ck auth enroll revoke --name ${vault.name}\` to revoke it in the vault too.`
                },
              },
            ]
          : [
              {
                id: 'connect',
                label: 'Connect',
                description:
                  'Asks the vault to enroll this host; you approve the request with `ck`.',
                run: async ({ invocation }) => {
                  const step = await vault.connectStep()
                  if (step.state !== 'pending' && step.state !== 'busy') {
                    await deps.changed?.()
                    return vaultConnectOutcome(vault, step)
                  }
                  // The approval happens outside this menu; keep polling for
                  // it and report the outcome to the session that asked.
                  void vault
                    .waitForApproval()
                    .then(async (final) => {
                      await deps.changed?.()
                      const outcome = vaultConnectOutcome(vault, final)
                      invocation.notify(
                        outcome.text,
                        outcome.ok ? 'info' : 'warning',
                      )
                    })
                    .catch((error: unknown) => {
                      invocation.notify(
                        `Connecting to the vault failed: ${error instanceof Error ? error.message : String(error)}`,
                        'error',
                      )
                    })
                  return {
                    ok: true,
                    text: [
                      ...vaultApprovalInstructions(vault.name, step),
                      'Waiting for the approval; you are told here when it lands.',
                    ].join('\n'),
                  }
                },
              },
            ],
      }
    },
  }
}

export interface ResetCreditsDeps {
  configPath: string
  statePath: string
  quotaManager: Pick<QuotaManager, 'isRateLimited' | 'getMain' | 'getFallback'>
  loadAccounts: typeof defaultLoadAccounts
  /** The writer of the reset state: `settingsMutateAccounts` on a migrated install. */
  mutateAccounts: typeof defaultMutateAccounts
  resolveResetTarget(accountKey: string): Promise<ResetTargetIdentity>
  refreshResetTargetQuota(accountKey: string): Promise<RefreshAllQuotaResult>
  fetchImpl: typeof fetch
  now: () => number
  randomUUID: () => string
  /** The accounts a credit can be spent on, `main` first. */
  accountKeys(): Promise<string[]>
}

/**
 * Spends one reset credit on `accountKey`. A first attempt fetches a fresh
 * preview and binds the redemption to the ChatGPT account it names; a retry,
 * or any attempt while a redemption is saved as in flight, goes to the
 * account's current identity and replays the saved identifiers.
 */
async function spendResetCredit(
  deps: ResetCreditsDeps,
  accountKey: string,
  retry: boolean,
): Promise<ResetStepResult> {
  if (!isSafeResetAccountKey(accountKey))
    return resetResultPayload(
      accountKey,
      'invalid_account_key',
      'That account cannot take a reset credit.',
    )
  let expected: string | undefined
  try {
    // A redemption saved as in flight (its credit and request ids, under the
    // `reset` key) is what keeps an unknown outcome from becoming a second
    // spend: the coordinator replays exactly those ids (the server dedupes on
    // the request id) or, once the pair is older than its five-minute window
    // and the attempt is a new spend, refuses. So with one saved, or for a
    // retry, nothing is previewed: the request goes to the account's current identity and
    // the coordinator decides from the saved state, even after a restart.
    const saved = (
      await deps.loadAccounts({
        configPath: deps.configPath,
        statePath: deps.statePath,
      })
    )?.reset?.[accountKey]
    if (retry || (saved && Object.hasOwn(saved, 'inFlight'))) {
      expected = (await deps.resolveResetTarget(accountKey)).chatgptAccountId
    } else {
      const preview = await buildResetPreviewRow(accountKey, deps)
      if (!preview.eligible)
        return resetResultPayload(
          accountKey,
          'not_eligible',
          renderResetConfirm(preview),
        )
      expected = preview.chatgptAccountId
    }
    if (!expected)
      return resetResultPayload(
        accountKey,
        'not_eligible',
        'Cannot reset: stable ChatGPT account identity unavailable.',
      )
    log.info('reset redemption decision', { accountKey, retry })
    const result = await runResetCreditRedemption(
      {
        configPath: deps.configPath,
        statePath: deps.statePath,
        mutateAccountsFn: deps.mutateAccounts,
        loadAccountsFn: deps.loadAccounts,
        now: deps.now,
        randomUUID: deps.randomUUID,
        fetchImpl: deps.fetchImpl,
        resolveTarget: deps.resolveResetTarget,
        fetchUsage: (target) =>
          whamUsageFn({
            accessToken: target.accessToken,
            fetchImpl: deps.fetchImpl,
            now: deps.now,
            accountId: target.chatgptAccountId,
          }),
        hasActiveRateLimitMark: (key) => deps.quotaManager.isRateLimited(key),
      },
      { accountKey, expectedChatgptAccountId: expected, retry },
    )
    log.info('reset redemption outcome', {
      accountKey,
      code: result.outcome.kind,
    })
    return renderResetCoordinatorResult(result, deps, expected)
  } catch (error) {
    const outcome = resetErrorPayload(accountKey, error, expected)
    log.info('reset redemption outcome', { accountKey, code: outcome.code })
    return outcome
  }
}

/** Reset credits: preview an account, spend a credit, retry a redemption. */
export function resetCreditsSection(
  deps: ResetCreditsDeps,
): PluginExtraSection {
  return {
    id: 'reset',
    title: 'Reset credits',
    build: async () => ({
      lines: [
        "A reset credit restores an exhausted account's quota. Preview fetches the account's current quota and credits.",
      ],
      items: (await deps.accountKeys()).map((accountKey) => ({
        id: accountKey,
        label: accountKey === MAIN_ROW_ID ? 'Main account' : accountKey,
        actions: [
          {
            id: 'preview',
            label: 'Preview',
            run: async () => {
              const row = await buildResetPreviewRow(accountKey, deps)
              return {
                ok: row.eligible,
                text: `${resetRowDetail(row)}\n\n${renderResetConfirm(row)}`,
              }
            },
          },
          {
            id: 'spend',
            label: 'Spend a reset credit',
            irreversible: true,
            confirm:
              'Spend one reset credit on this account? Its eligibility is checked again first, and nothing is spent when it is not eligible.',
            run: async () => {
              const { ok, text } = await spendResetCredit(
                deps,
                accountKey,
                false,
              )
              return { ok, text }
            },
          },
          {
            id: 'retry',
            label: 'Retry the last redemption',
            irreversible: true,
            confirm:
              'Retry the last redemption? A retry within five minutes reuses the same request and credit identifiers.',
            run: async () => {
              const { ok, text } = await spendResetCredit(
                deps,
                accountKey,
                true,
              )
              return { ok, text }
            },
          },
        ],
      })),
    }),
  }
}

// ---------------------------------------------------------------------------
// The menu
// ---------------------------------------------------------------------------

export interface OpenAiMenuOptions {
  store: PoolStore
  /**
   * The legacy locks the menu's writes that name no single row take (the
   * roster order, settings, a new account).
   */
  extraLocks?: readonly PoolLockSpec[]
  /** The legacy locks a write of one row takes; see `AccountRules`. */
  rowLocks?: AccountRules['rowLocks']
  /** Whether the install is migrated; absent means it always is (Pi). */
  migration?(): Promise<MenuMigrationState>
  login?: MenuLoginDeps
  /** Passed to every removal: refuses row `main` and a pending transfer's row. */
  protect?: RemoveOptions['protect']
  describeIdentity?: AccountsSectionOptions['describeIdentity']
  /** The plugin's "check quota now"; without it the store pulls each row. */
  quotaCheck?(
    ids: readonly string[],
    invocation: CommandInvocation,
  ): Promise<void>
  cache?: PluginSection
  diagnostics?: PluginSection
  extras?: readonly PluginExtraSection[]
  /** Runs after every successful apply (the host re-reads its rows). */
  afterApply?(): unknown
  logger?: SeamLogger
  now?: () => number
}

/** The routing modes this plugin routes besides `ordered` and sticky-balanced. */
export const ORDERED_VARIANTS = [
  { value: 'main-first', label: 'Main first' },
  { value: 'fallback-first', label: 'Fallback first' },
]

/** The quota windows a killswitch floor can be set for. */
export const FLOOR_LABELS = ['primary', 'secondary'] as const

/**
 * The `/openai` menu. On a migrated install it is the shared menu over the
 * pool store (wrapped by `withSettingsMigration`); otherwise `open` returns
 * the notice and `apply` changes nothing.
 */
export function createOpenAiMenu(options: OpenAiMenuOptions): CommandMenu {
  const menu = createCommandMenu({
    command: OPENAI_COMMAND_NAME,
    title: OPENAI_MENU_TITLE,
    store: withSettingsMigration(
      withAccountRules(options.store, {
        ...(options.rowLocks ? { rowLocks: options.rowLocks } : {}),
      }),
    ),
    ...(options.extraLocks ? { extraLocks: options.extraLocks } : {}),
    accounts: {
      ...(options.login ? { login: menuLogin(options.login) } : {}),
      ...(options.protect ? { protect: options.protect } : {}),
      ...(options.describeIdentity
        ? { describeIdentity: options.describeIdentity }
        : {}),
    },
    quota: options.quotaCheck ? { check: options.quotaCheck } : {},
    routing: { orderedVariants: ORDERED_VARIANTS, formerMainId: MAIN_ROW_ID },
    limits: { labels: FLOOR_LABELS },
    ...(options.cache ? { cache: options.cache } : {}),
    ...(options.diagnostics ? { diagnostics: options.diagnostics } : {}),
    ...(options.extras ? { extras: options.extras } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.now ? { now: options.now } : {}),
  })
  // A copy of the caller's context taken before the first await, as the
  // shared menu does: work left running reports through this copy even if
  // the host rebinds its context object for another session meanwhile.
  const own = (invocation: CommandInvocation): CommandInvocation => {
    const { sessionId } = invocation
    const notify = invocation.notify.bind(invocation)
    return { ...(sessionId !== undefined ? { sessionId } : {}), notify }
  }
  return {
    command: OPENAI_COMMAND_NAME,
    async open(invocation): Promise<CommandDialogPayload> {
      const context = own(invocation)
      const state = await options.migration?.()
      if (state && !state.migrated)
        return {
          command: OPENAI_COMMAND_NAME,
          menu: migrationNoticeMenu(state.blockers),
        }
      return menu.open(context)
    },
    async apply(
      request: CommandApplyRequest,
      invocation: CommandInvocation,
    ): Promise<CommandApplyResult> {
      const context = own(invocation)
      const state = await options.migration?.()
      if (state && !state.migrated)
        return {
          command: OPENAI_COMMAND_NAME,
          ok: false,
          text: 'Nothing was changed: the accounts have not moved to the new layout yet.',
          menu: migrationNoticeMenu(state.blockers),
        }
      const result = await menu.apply(request, context)
      if (result.ok) await options.afterApply?.()
      return result
    },
  }
}

type ResetPreviewRow = {
  accountKey: string
  label: string
  chatgptAccountId?: string
  usedPercent?: number
  resetTime?: string
  availableCount?: number
  applicableAvailableCount?: number
  eligible: boolean
  reason?: string
  selectedCreditId?: string
  selectedCreditExpiresAt?: string
}

type ResetCommandContext = ResetCreditsDeps

function resetUsedPercent(snapshot: {
  primary?: { usedPercent: number }
  secondary?: { usedPercent: number }
}): number | undefined {
  const values = [
    snapshot.primary?.usedPercent,
    snapshot.secondary?.usedPercent,
  ].filter((value): value is number => value !== undefined)
  return values.length > 0 ? Math.max(...values) : undefined
}

function resetWindowTime(
  snapshot: {
    primary?: { usedPercent: number; resetsAt?: string }
    secondary?: { usedPercent: number; resetsAt?: string }
  },
  now: number,
): string | undefined {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is { usedPercent: number; resetsAt?: string } =>
      window !== undefined,
  )
  const liveExhausted = windows.filter((window) =>
    resetWindowIsExhausted(window, now),
  )
  return (liveExhausted.length > 0 ? liveExhausted : windows).sort(
    (left, right) => right.usedPercent - left.usedPercent,
  )[0]?.resetsAt
}

function resetSnapshotIsHealthy(
  snapshot:
    | {
        primary?: { usedPercent: number; resetsAt?: string }
        secondary?: { usedPercent: number; resetsAt?: string }
      }
    | undefined,
  now: number,
): boolean {
  if (!snapshot) return false
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is { usedPercent: number; resetsAt?: string } =>
      window !== undefined,
  )
  if (windows.length === 0) return false
  return windows.every((window) => !resetWindowIsExhausted(window, now))
}

async function buildResetPreviewRow(
  accountKey: string,
  ctx: ResetCommandContext,
): Promise<ResetPreviewRow> {
  let target: ResetTargetIdentity | undefined
  try {
    target = await ctx.resolveResetTarget(accountKey)
    const wireAccountId =
      target.accountKey === 'main' ? undefined : target.chatgptAccountId
    const [quota, credits] = await Promise.all([
      whamUsageFn({
        accessToken: target.accessToken,
        fetchImpl: ctx.fetchImpl,
        now: ctx.now,
        accountId: target.chatgptAccountId,
      }),
      listResetCredits(ctx.fetchImpl, target.accessToken, wireAccountId),
    ])
    const selectedCredit = selectCreditToSpend(credits.credits)
    const eligibleCreditCount = countEligibleResetCredits(credits.credits)
    const availableCount =
      credits.availableCount ??
      quota.resetCreditsAvailable ??
      (eligibleCreditCount > 0 ? eligibleCreditCount : undefined)
    const applicableAvailableCount = quota.resetCreditsApplicable
    const precondition = evaluateResetPrecondition(
      quota,
      ctx.quotaManager.isRateLimited(accountKey),
      ctx.now(),
    )
    let reason: string | undefined
    if (!target.chatgptAccountId) {
      reason = 'stable ChatGPT account identity unavailable'
    } else if (!precondition.ok) {
      reason = precondition.reason
    } else if (!selectedCredit) {
      reason = 'no eligible credit'
    }
    return {
      accountKey: target.accountKey,
      label: target.label,
      chatgptAccountId: target.chatgptAccountId,
      usedPercent: resetUsedPercent(quota),
      resetTime: resetWindowTime(quota, ctx.now()),
      availableCount,
      applicableAvailableCount,
      eligible: reason === undefined,
      reason,
      selectedCreditId: selectedCredit?.id,
      selectedCreditExpiresAt: selectedCredit?.expiresAt,
    }
  } catch (error) {
    if ((error as { status?: unknown })?.status === 401)
      await target?.onAuthFailure?.(401)
    log.warn('reset preview row failed', {
      accountKey,
      error: (error as Error)?.message ?? String(error),
    })
    return {
      accountKey,
      label: accountKey === 'main' ? 'Main account' : accountKey,
      eligible: false,
      reason: (error as Error)?.message ?? String(error),
    }
  }
}

/** One account's line in the reset section: usage, credits and eligibility. */
function resetRowDetail(row: ResetPreviewRow): string {
  const usage =
    row.usedPercent === undefined
      ? 'quota unavailable'
      : `${row.usedPercent}% used`
  const credits =
    row.availableCount === undefined
      ? 'credits unavailable'
      : `${row.applicableAvailableCount === undefined ? '?' : row.applicableAvailableCount}/${row.availableCount} applicable/available`
  const status = row.eligible
    ? `eligible · credit ${row.selectedCreditId} expires ${row.selectedCreditExpiresAt}`
    : row.reason
  return `${usage}; ${credits}; ${status}`
}

function renderResetConfirm(row: ResetPreviewRow): string {
  const lines = [
    '## Confirm reset credit',
    '',
    `Account: **${row.label}** (\`${row.accountKey}\`)`,
    `Current quota: **${row.usedPercent ?? 'unknown'}% used**`,
    `Credit: **Spend 1 of ${row.availableCount ?? 'unknown'}**`,
    `Credit expires: **${row.selectedCreditExpiresAt ?? 'unavailable'}**`,
    `Quota resets: **${row.resetTime ?? 'unavailable'}**`,
    '',
  ]
  if ((row.availableCount ?? 0) > 0 && row.applicableAvailableCount === 0) {
    lines.push(
      'The server does not currently count this credit as applicable; redemption may return a no-op, and a no-op does not spend the credit.',
    )
    lines.push('')
  }
  if (row.eligible && row.chatgptAccountId) {
    lines.push('Eligible: choose "Spend a reset credit" to redeem one.')
  } else {
    lines.push(`Cannot reset: **${row.reason ?? 'not eligible'}**`)
  }
  return lines.join('\n')
}

/**
 * What one reset step came to: the message for the user and the outcome
 * code (a server outcome, a coordinator refusal or a local one), which the
 * log and the tests read.
 */
export interface ResetStepResult {
  ok: boolean
  code: string
  text: string
}

// `accountKey` and the extra details are what the old dialog carried; they
// are logged rather than shown, so the message alone tells the user what
// happened and the details stay out of the payload.
function resetResultPayload(
  accountKey: string,
  code: string,
  text: string,
  details: Record<string, unknown> = {},
): ResetStepResult {
  if (Object.keys(details).length > 0)
    log.debug('reset step details', { accountKey, code, ...details })
  return {
    ok: code === 'reset' || code === 'already_redeemed',
    code,
    text,
  }
}

function resetErrorPayload(
  accountKey: string,
  error: unknown,
  boundChatgptAccountId?: string,
): ResetStepResult {
  if (error instanceof ResetRedemptionError) {
    const messages: Record<string, string> = {
      identity_mismatch:
        'The account identity changed before redemption. Reopen the reset account list.',
      invalid_account_key:
        'The selected account key is reserved. Reopen the reset account list.',
      cooldown_active:
        'This account just reset — re-checking quota. Wait for the cooldown before another redemption.',
      expired_unreconciled:
        'The previous attempt outcome is unknown — retry replays the same identifiers, or wait until quota reflects the earlier attempt.',
      retry_without_inflight:
        'There is no active reset redemption to retry. Reopen the account list.',
      not_exhausted:
        'No credit was spent: the fresh account state is not exhausted.',
      no_eligible_credit:
        'No credit was spent: no eligible credit was returned.',
    }
    return resetResultPayload(
      accountKey,
      error.kind,
      `## Reset credit\n\n${messages[error.kind]}\n\nCode: \`${error.kind}\``,
      {
        cooldownUntil: error.cooldownUntil,
        ...(error.kind === 'expired_unreconciled'
          ? {
              chatgptAccountId: boundChatgptAccountId,
              retryGuidance:
                'Retry replays the same request and credit identifiers from the previous attempt.',
            }
          : {}),
      },
    )
  }
  const identityCode = (error as { code?: unknown })?.code
  if (
    identityCode === 'unknown_account' ||
    identityCode === 'disabled_account' ||
    identityCode === 'non_oauth_account' ||
    identityCode === 'token_unavailable'
  ) {
    const messages = {
      unknown_account:
        'Account unavailable: the selected account no longer exists. Reopen the reset account list.',
      disabled_account:
        'Account unavailable: the selected account is disabled. Reopen the reset account list.',
      non_oauth_account:
        'Account unavailable: the selected account is not authenticated with OAuth. Reopen the reset account list.',
      token_unavailable:
        'Authentication problem: the selected account token is unavailable. Reauthenticate the account before retrying.',
    } as const
    return resetResultPayload(
      accountKey,
      identityCode,
      `## Reset credit\n\n${messages[identityCode]}\n\nCode: \`${identityCode}\``,
    )
  }
  if (error instanceof ResetCreditError) {
    return resetResultPayload(
      accountKey,
      error.kind,
      `## Reset credit\n\nNo redemption was attempted: reset credit availability could not be loaded.\n\nCode: \`${error.kind}\``,
    )
  }
  log.warn('reset command failed before a known result', {
    accountKey,
    error: (error as Error)?.message ?? String(error),
  })
  return resetResultPayload(
    accountKey,
    'error',
    '## Reset credit\n\nThe reset request failed before a known result: internal command failure — see plugin log.',
  )
}

export async function renderResetCoordinatorResult(
  result: RunResetCreditResult,
  ctx: ResetCommandContext,
  boundChatgptAccountId?: string,
): Promise<ResetStepResult> {
  const { accountKey } = result.target
  const code = result.outcome.kind
  if (result.finalizeStateWriteFailed) {
    return resetResultPayload(
      accountKey,
      code,
      `## Reset credit result\n\nAccount: **${result.target.label}** (\`${accountKey}\`)\n\nThe server outcome recorded as \`${code}\`, but the state write failed. A retry within five minutes reuses the same request and credit identifiers; this does not prove the server did nothing.`,
      {
        stateWriteFailed: true,
        retryGuidance: result.retrySafety,
        chatgptAccountId: boundChatgptAccountId,
      },
    )
  }
  if (code === 'reset' || code === 'already_redeemed') {
    let refresh: RefreshAllQuotaResult = {
      account: accountKey,
      ok: false,
      error: 'targeted quota refresh did not complete',
    }
    try {
      refresh = await ctx.refreshResetTargetQuota(accountKey)
    } catch (error) {
      refresh.error = (error as Error)?.message ?? String(error)
    }
    const refreshFailed = !refresh.ok && refresh.error !== undefined
    if (refreshFailed) {
      log.warn('reset quota re-check failed', {
        accountKey,
        error: refresh.error,
      })
    }
    const entry =
      accountKey === 'main'
        ? ctx.quotaManager.getMain()
        : ctx.quotaManager.getFallback(accountKey)
    const verifiedFresh =
      refresh.ok && resetSnapshotIsHealthy(entry?.quota, ctx.now())
    const remainingCredits = entry?.quota.resetCreditsApplicable
    const verification = verifiedFresh
      ? 'Post-verification: **window fresh**.'
      : `Post-verification: **window not yet refreshed** (server code \`${code}\`).`
    const refreshDiagnostic = refreshFailed
      ? '\n\nquota re-check failed — see log.'
      : ''
    return resetResultPayload(
      accountKey,
      code,
      `## Reset credit result\n\nAccount: **${result.target.label}** (\`${accountKey}\`)\n\nCode: \`${code}\`\n\n${verification}${refreshDiagnostic}${remainingCredits === undefined ? '' : `\n\nRemaining applicable credits: **${remainingCredits}**`}`,
      {
        verifiedFresh,
        afterUsedPercent: resetUsedPercent(entry?.quota ?? {}),
        remainingCredits,
      },
    )
  }
  if (code === 'ambiguous_local') {
    return resetResultPayload(
      accountKey,
      code,
      `## Reset credit result\n\nAccount: **${result.target.label}** (\`${accountKey}\`)\n\nCode: \`${code}\`\n\n${result.retrySafety}`,
      { retryGuidance: result.retrySafety },
    )
  }
  if (code === 'ambiguous' || code === 'http_error') {
    return resetResultPayload(
      accountKey,
      code,
      `## Reset credit result\n\nAccount: **${result.target.label}** (\`${accountKey}\`)\n\nThe redemption outcome is unknown (\`${code}\`).\n\nRetry with "Retry the last redemption" on this account. A retry within five minutes reuses the same request and credit identifiers; this does not prove the server did nothing.`,
      {
        retryGuidance: result.retrySafety,
        chatgptAccountId: boundChatgptAccountId,
      },
    )
  }
  const meanings: Record<string, string> = {
    nothing_to_reset:
      'The server found no exhausted quota window to reset. No reset was confirmed. A new attempt starts fresh and must pass the current preconditions.',
    no_credit:
      'The server found no usable reset credit. No reset was confirmed. A new attempt starts fresh and must pass the current preconditions.',
  }
  return resetResultPayload(
    accountKey,
    code,
    `## Reset credit result\n\nAccount: **${result.target.label}** (\`${accountKey}\`)\n\nCode: \`${code}\`\n\n${meanings[code] ?? 'The server returned a no-op result. No reset was confirmed.'}`,
  )
}
