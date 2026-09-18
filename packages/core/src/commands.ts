import {
  type AccountPaths,
  claustrumMode,
  type loadAccounts as defaultLoadAccounts,
  type FallbackAccount,
  isSafeResetAccountKey,
  mutateAccounts,
  type OAuthAccount,
  type OAuthSpendControlReading,
  type RoutingMode,
  readConfigRosterIds,
} from './accounts'
import { createLogger } from './logger'
import { beginAccountLogin, upsertAccount } from './oauth'
import type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
  OpenDialogPayload,
} from './protocol'
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

// ---------------------------------------------------------------------------
// Command name constants
// ---------------------------------------------------------------------------

export const OPENAI_QUOTA_COMMAND_NAME = 'openai-quota'
export const OPENAI_ACCOUNT_COMMAND_NAME = 'openai-account'
export const OPENAI_ROUTING_COMMAND_NAME = 'openai-routing'
export const OPENAI_KILLSWITCH_COMMAND_NAME = 'openai-killswitch'
export const OPENAI_DUMP_COMMAND_NAME = 'openai-dump'
export const OPENAI_LOGGING_COMMAND_NAME = 'openai-logging'
export const OPENAI_CACHEKEEP_COMMAND_NAME = 'openai-cachekeep'
export const OPENAI_RESET_COMMAND_NAME = 'openai-reset'

export const MODAL_COMMANDS: CommandModalName[] = [
  'openai-quota',
  'openai-account',
  'openai-routing',
  'openai-killswitch',
  'openai-dump',
  'openai-logging',
  'openai-cachekeep',
  'openai-reset',
]

// ---------------------------------------------------------------------------
// Dependency injection context
// ---------------------------------------------------------------------------

/**
 * The prompt-cache manager, as the commands use it.
 *
 * Declared structurally rather than imported: the manager itself is tied to one
 * host's live request loader and stays there. Only the members reached through
 * this field appear here — a status snapshot, the two lifecycle calls the
 * cachekeep command makes, and the per-session drop the host performs when a
 * session ends.
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

export interface CommandContext {
  accountStoragePath: string
  /**
   * Runtime-state file that goes with `accountStoragePath`. Required, and
   * resolved by the host: nothing here derives one path from the other.
   */
  accountStatePath: string
  /** Host package version, sent as the version half of the OAuth `User-Agent`. */
  packageVersion: string
  quotaManager: QuotaManager
  loadAccounts: typeof defaultLoadAccounts
  client: {
    auth: {
      set: (input: {
        path: { id: string }
        body: {
          type: string
          access?: string
          refresh: string
          expires?: number
        }
      }) => Promise<unknown>
    }
  }
  /** Session ID for pushNotification delivery. */
  sessionId?: string
  /** If set, pushNotification is wired up and can deliver feedback to the user. */
  notify?: (payload: OpenDialogPayload) => void
  /** Refresh the sidebar-state file so the TUI modal shows current data. */
  refreshSidebar?: () => Promise<void>
  /** Actively poll wham/usage for all accounts (main + fallbacks). */
  refreshAllQuota?: () => Promise<RefreshAllQuotaResult[]>
  /** Prompt-cache cachekeep manager. Set when the command is wired. */
  cacheKeepManager?: CacheKeepManager | null
  /** Updates the live loader's persisted-enabled cachekeep gate. */
  setCacheKeepEnabled?: (enabled: boolean) => void
  /** Updates the live loader's persisted-subagent cachekeep gate. */
  setCacheKeepSubagents?: (enabled: boolean) => void
  /** Updates the live loader's main-agent idle-cap bypass gate. */
  setCacheKeepSustain?: (enabled: boolean) => void
  /** Updates the live loader's clock-hour warm window. undefined = no window. */
  setCacheKeepWindow?: (
    window: { startHour: number; endHour: number } | undefined,
  ) => void
  /** Clears only the sticky account assignment for one OpenCode session. */
  clearStickyRouting?: (sessionId: string) => Promise<boolean>
  /** Resolves the current session's usable sticky account, if one exists. */
  getStickyRouting?: (sessionId: string) => Promise<string | undefined>
  resolveResetTarget?: (accountKey: string) => Promise<ResetTargetIdentity>
  fetchImpl?: typeof fetch
  now?: () => number
  randomUUID?: () => string
  /** Starts an OAuth account-add flow; injected by the runtime boundary. */
  beginAccountLogin?: typeof beginAccountLogin
  refreshResetTargetQuota?: (
    accountKey: string,
  ) => Promise<RefreshAllQuotaResult>
  enterClaustrumMode?: () => Promise<{
    status: 'completed' | 'incomplete' | 'aborted'
    outcomes: Record<string, string>
    reason?: string
  }>
  leaveClaustrumMode?: () => Promise<void>
  withFallbackAccountLock?: <T>(
    accountId: string,
    action: () => Promise<T>,
  ) => Promise<T>
  checkUsableCustodyBinding?: (
    account: OAuthAccount,
  ) => Promise<
    { ready: true; accountId: string } | { ready: false; reason: string }
  >
}

export interface ResetTargetIdentity {
  accountKey: string
  label: string
  accessToken: string
  chatgptAccountId?: string
  onAuthFailure?: (status: number) => Promise<void>
}

/**
 * A command body a host supplies for a command the core does not own.
 *
 * Four commands read state that only the OpenCode plugin process has — the
 * live request loader's gates and its memoized settings — so their bodies stay
 * in that host. They are still reached through the entry points below, so the
 * credential scrubbing runs on their payloads exactly as it does on ours.
 */
export type HostCommandBody = (
  args: string,
  ctx: CommandContext,
) => Promise<OpenDialogPayload>

export type HostCommandBodies = Partial<
  Record<CommandModalName, HostCommandBody>
>

const log = createLogger('commands')

/** The config/state pair a context describes, in the shape the store takes. */
function storePaths(ctx: CommandContext): AccountPaths {
  return {
    configPath: ctx.accountStoragePath,
    statePath: ctx.accountStatePath,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routingDescription(mode: RoutingMode) {
  if (mode === 'fallback-first') {
    return 'Try usable fallback accounts before the main account.'
  }
  if (mode === 'sticky-balanced') {
    return 'Keep each session on its assigned account while balancing new sessions.'
  }
  return 'Try the main account first. Use fallback accounts only when required.'
}

// ---------------------------------------------------------------------------
// Per-command execution functions
// ---------------------------------------------------------------------------

// Three missed polls at the 5-minute cadence. Below this, a stamp is just the
// normal gap between refreshes and saying so would put an age on every line
// permanently, which trains the reader to ignore it.
const QUOTA_STALE_AFTER_MS = 15 * 60 * 1000

/**
 * Render how old a quota reading is, or nothing while it is current.
 *
 * Keyed on the reading's OWN timestamp rather than the poll's. A poll can
 * succeed while leaving an account untouched — that is exactly what happens
 * once an account's refresh backoff is armed and the poll skips it — so the
 * poll's clock would report freshness the numbers do not have. That gap is what
 * let one account's bars sit unchanged for 31 hours while the surface looked
 * healthy.
 */
function quotaAge(checkedAt: number | undefined, now: number): string {
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt)) {
    return ' (age unknown)'
  }
  const ageMs = now - checkedAt
  if (ageMs < QUOTA_STALE_AFTER_MS) return ''
  const hours = Math.floor(ageMs / 3600_000)
  if (hours >= 24) return ` (${Math.floor(hours / 24)}d old)`
  if (hours >= 1) return ` (${hours}h old)`
  return ` (${Math.floor(ageMs / 60_000)}m old)`
}

function formatSpendControlLine(
  spendControl: OAuthSpendControlReading,
  indent = '',
): string {
  const resets = spendControl.resetsAt
    ? ` · resets ${spendControl.resetsAt}`
    : ''
  return `${indent}- credits: ${Math.round(spendControl.usedPercent)}% used (${Math.round(spendControl.used)} / ${Math.round(spendControl.limit)}, ${Math.round(spendControl.remaining)} remaining)${resets}`
}

async function executeQuotaCommand(
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const refreshResults = await ctx.refreshAllQuota?.()
  const mainEntry = ctx.quotaManager.getMain()
  const now = Date.now()
  const lines: string[] = ['## OpenAI Quota', '']

  if (mainEntry?.quota) {
    const q = mainEntry.quota
    lines.push('### Main account')
    for (const key of ['primary', 'secondary'] as const) {
      const w = q[key]
      if (w) {
        const pct = Math.round(w.usedPercent)
        const bar =
          '█'.repeat(Math.max(0, Math.min(Math.round(pct / 10), 10))) +
          '░'.repeat(Math.max(0, 10 - Math.min(Math.round(pct / 10), 10)))
        lines.push(
          `- ${key}: ${bar} ${pct}% used (${Math.round(w.remainingPercent)}% remaining)${quotaAge(w.checkedAt ?? mainEntry.checkedAt, now)}`,
        )
      }
    }
    if (q.resetCreditsAvailable !== undefined) {
      lines.push(`- resets: ${q.resetCreditsAvailable}`)
    }
    if (q.spendControl) {
      lines.push(formatSpendControlLine(q.spendControl))
    }
  } else {
    lines.push('No main quota snapshot available. Send a request first.')
  }

  const fallbacks = ctx.quotaManager.getAllFallbacks()
  const fbEntries = [...fallbacks.entries()].filter(([, e]) => e)
  if (fbEntries.length > 0) {
    lines.push('')
    lines.push('### Fallback accounts')
    for (const [id, entry] of fbEntries) {
      if (!entry?.quota) continue
      lines.push(`**${id}**`)
      for (const key of ['primary', 'secondary'] as const) {
        const w = entry.quota[key]
        if (w) {
          const pct = Math.round(w.usedPercent)
          lines.push(
            `  - ${key}: ${pct}% used (${Math.round(w.remainingPercent)}% remaining)${quotaAge(w.checkedAt ?? entry.checkedAt, now)}`,
          )
        }
      }
      if (entry.quota.resetCreditsAvailable !== undefined) {
        lines.push(`  - resets: ${entry.quota.resetCreditsAvailable}`)
      }
      if (entry.quota.spendControl) {
        lines.push(formatSpendControlLine(entry.quota.spendControl, '  '))
      }
    }
  }

  if (refreshResults?.length) {
    const failures = refreshResults.filter((r) => !r.ok)
    if (failures.length > 0) {
      lines.push('')
      for (const f of failures) {
        // Two different messages, because they need two different actions.
        // Every failure used to read "fetch failed — Refresh to retry", which
        // made a token the provider had permanently rejected look like a
        // momentary blip and recommended a remedy that cannot work: refreshing
        // never revives such a token, so an operator following that advice
        // waits indefinitely instead of re-adding the account.
        //
        // The raw error stays hidden on purpose — it names internal endpoints
        // and helps nobody here. What the operator needs is which of the two
        // situations they are in.
        lines.push(
          f.permanent
            ? `- ${f.account}: sign-in no longer accepted — remove and add this account again`
            : `- ${f.account}: fetch failed — Refresh to retry`,
        )
      }
    }
  }

  return { command: 'openai-quota', text: lines.join('\n'), knobs: {} }
}

/**
 * Project a stored account down to the fields a dialog may see.
 *
 * Stored accounts carry live credentials (`access`, `refresh`, `apiKey`). Knobs
 * are returned across the loopback RPC boundary and JSON-serialized to the TUI,
 * so handing back raw account objects would publish those secrets to every RPC
 * client and into anything that logs an apply result. The dialogs only ever need
 * identity here — the account list is rendered from `text`, and the TUI reads
 * nothing from these entries but their count.
 *
 * Build the result field by field. A destructuring omit (`...rest`) would
 * silently republish any secret added to the account types later.
 */
function accountKnob(account: FallbackAccount) {
  return {
    id: account.id,
    type: account.type ?? 'oauth',
    enabled: account.enabled,
    label: account.label,
  }
}

async function executeAccountCommand(
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const storage = (await ctx.loadAccounts(storePaths(ctx))) ?? {
    version: 1 as const,
    accounts: [],
  }
  const accounts = storage.accounts ?? []

  if (tokens[0] === 'claustrum') {
    if (!ctx.enterClaustrumMode) {
      return {
        command: 'openai-account',
        text: '## Claustrum Unavailable\n\nThe custody runtime is not ready. Try again after OpenAI auth finishes initializing.',
        knobs: {
          accounts: accounts.map(accountKnob),
          claustrumMode: claustrumMode(storage),
        },
      }
    }
    const result = await ctx.enterClaustrumMode()
    const nextStorage = (await ctx.loadAccounts(storePaths(ctx))) ?? {
      version: 1 as const,
      accounts: [],
    }
    const rows = Object.entries(result.outcomes).map(
      ([id, outcome]) => `- \`${id}\`: ${outcome}`,
    )
    return {
      command: 'openai-account',
      text: [
        `## Claustrum ${result.status}`,
        '',
        'do not run a login in another OpenCode window during this transition',
        '',
        ...(rows.length > 0 ? rows : ['- No enabled OAuth accounts.']),
        ...(result.reason ? ['', `Reason: ${result.reason}`] : []),
      ].join('\n'),
      knobs: {
        accounts: nextStorage.accounts.map(accountKnob),
        claustrumMode: claustrumMode(nextStorage),
      },
    }
  }

  if (tokens[0] === 'local') {
    if (!ctx.leaveClaustrumMode) {
      return {
        command: 'openai-account',
        text: '## Local Mode Unavailable\n\nThe custody runtime is not ready. Try again after OpenAI auth finishes initializing.',
        knobs: {
          accounts: accounts.map(accountKnob),
          claustrumMode: claustrumMode(storage),
        },
      }
    }
    await ctx.leaveClaustrumMode()
    const nextStorage = (await ctx.loadAccounts(storePaths(ctx))) ?? {
      version: 1 as const,
      accounts: [],
    }
    return {
      command: 'openai-account',
      text: '## Local Mode\n\nClaustrum mode is now local. Run a fresh `/login openai` for each account, then remove its binding with `ck auth` before it can refresh locally.',
      knobs: {
        accounts: nextStorage.accounts.map(accountKnob),
        claustrumMode: claustrumMode(nextStorage),
      },
    }
  }

  if ((tokens[0] === 'enable' || tokens[0] === 'disable') && tokens[1]) {
    const targetId = tokens[1]
    const enabled = tokens[0] === 'enable'
    let refusal: string | undefined
    let found = false
    const withAccountLock =
      ctx.withFallbackAccountLock ?? (async (_accountId, action) => action())
    const next = await withAccountLock(targetId, async () => {
      const current = await ctx.loadAccounts(storePaths(ctx))
      const currentAccount = current?.accounts.find(
        (account): account is OAuthAccount =>
          account.id === targetId && account.type === 'oauth',
      )
      if (!currentAccount)
        return current ?? { version: 1 as const, accounts: [] }
      if (enabled && claustrumMode(current) === 'claustrum') {
        const binding = ctx.checkUsableCustodyBinding
          ? await ctx.checkUsableCustodyBinding(currentAccount)
          : {
              ready: false as const,
              reason: 'unbound-under-claustrum' as const,
            }
        if (!binding.ready) {
          refusal = binding.reason
          return current
        }
        return mutateAccounts((latest) => {
          const account = latest.accounts.find(
            (candidate): candidate is OAuthAccount =>
              candidate.id === targetId && candidate.type === 'oauth',
          )
          if (!account) return latest
          found = true
          account.accountId = binding.accountId
          account.enabled = true
          return latest
        }, storePaths(ctx))
      }
      return mutateAccounts((latest) => {
        const account = latest.accounts.find(
          (candidate) => candidate.id === targetId,
        )
        if (!account) return latest
        found = true
        account.enabled = enabled
        return latest
      }, storePaths(ctx))
    })
    const resolvedNext = next ?? { version: 1 as const, accounts: [] }
    if (refusal) {
      return {
        command: 'openai-account',
        text: `## Cannot Enable Account\n\n\`${targetId}\` remains disabled: ${refusal}. Resolve the custody binding, then try again.`,
        knobs: {
          accounts: resolvedNext.accounts.map(accountKnob),
          claustrumMode: claustrumMode(resolvedNext),
        },
      }
    }
    if (!found) {
      return {
        command: 'openai-account',
        text: `## Account Not Found\n\nNo account with id \`${targetId}\` exists.`,
        knobs: {
          accounts: resolvedNext.accounts.map(accountKnob),
          claustrumMode: claustrumMode(resolvedNext),
        },
      }
    }
    return {
      command: 'openai-account',
      text: `## Account ${enabled ? 'Enabled' : 'Disabled'}\n\n\`${targetId}\` is ${enabled ? 'enabled' : 'disabled'}.`,
      knobs: {
        accounts: resolvedNext.accounts.map(accountKnob),
        claustrumMode: claustrumMode(resolvedNext),
      },
    }
  }

  if (tokens.length === 0 || (tokens.length === 1 && tokens[0] === 'list')) {
    // Show status
    const lines = ['## OpenAI Accounts', '']
    if (accounts.length === 0) {
      lines.push(
        'No accounts configured. Use `/login openai` to add your main account, or `/openai-account add` to add a fallback account.',
      )
    } else {
      const mode: RoutingMode = storage.routing?.mode ?? 'main-first'
      lines.push(
        `Routing: \`${mode}\` (set with \`/openai-routing\`). Modes: main-first, fallback-first, or sticky-balanced. \`/openai-routing reset\` clears this session's pin.`,
      )
      lines.push('')
      for (const a of accounts) {
        const type = (a as { type?: string }).type ?? 'oauth'
        lines.push(`- \`${a.id}\` (${type})`)
      }
    }
    lines.push('')
    lines.push(
      `Claustrum mode: \`${claustrumMode(storage)}\`\n\nCommands: \`/openai-account claustrum\` | \`/openai-account local\` | \`/openai-account add [label]\` | \`/openai-account enable <id>\` | \`/openai-account disable <id>\` | \`/openai-account remove <id>\``,
    )
    return {
      command: 'openai-account',
      text: lines.join('\n'),
      knobs: {
        accounts: accounts.map(accountKnob),
        claustrumMode: claustrumMode(storage),
      },
    }
  }

  if (tokens[0] === 'remove' && tokens[1]) {
    const targetId = tokens[1]
    // Structural edit: route through mutateAccounts so the deletion is written
    // authoritatively. saveAccounts union-merges latest ∪ incoming by id, which
    // would resurrect the removed account from the on-disk `latest` set.
    //
    // `allowDrop` is unconditional for the target id. For a healthy entry it
    // is a no-op (the mutator splices, preservation already wouldn't fire for
    // a loaded id). For a load-dropped entry the mutator's splice no-ops,
    // but preservation would resurrect the raw entry — allowDrop suppresses
    // it. Behaviour (disk state) is therefore race-free inside the lock.
    //
    // The user-facing message comes from two signals OR'd together:
    //   - the mutator's splice (authoritative for healthy ids)
    //   - a pre-read of the raw roster that the mutator's current.accounts
    //     cannot see (load-dropped ids, which normalize rejected).
    // The pre-read is purely diagnostic — its staleness can only change the
    // message when another writer races us between read and lock, and the
    // mutator signal covers exactly that case. It is NOT load-bearing for
    // disk behaviour; that is `allowDrop`'s job now.
    const rawRoster = await readConfigRosterIds(ctx.accountStoragePath)
    const preReadSawIt = rawRoster ? rawRoster.has(targetId) : false

    let mutatorSplicedIt = false
    const next = await mutateAccounts(
      (current) => {
        const idx = current.accounts.findIndex((a) => a.id === targetId)
        if (idx === -1) return current
        current.accounts.splice(idx, 1)
        mutatorSplicedIt = true
        return current
      },
      storePaths(ctx),
      { allowDrop: [targetId] },
    )

    const removed = mutatorSplicedIt || preReadSawIt

    if (!removed) {
      return {
        command: 'openai-account',
        text: `## Account Not Found\n\nNo account with id \`${targetId}\` exists.`,
        knobs: { accounts: next.accounts.map(accountKnob) },
      }
    }

    log.info('account removed', { id: targetId })
    void ctx.refreshSidebar?.().catch(() => {})

    return {
      command: 'openai-account',
      text: `## Account Removed\n\nRemoved account \`${targetId}\`.`,
      knobs: { accounts: next.accounts.map(accountKnob) },
    }
  }

  if (tokens[0] === 'order' && tokens.length >= 3) {
    // Reorder: swap positions of two accounts. Structural edit — route through
    // mutateAccounts. saveAccounts seeds its union map latest-first, so a
    // reordered `incoming` array would be ignored and the swap silently lost.
    let ok = false
    const next = await mutateAccounts((current) => {
      const a = current.accounts.findIndex((ac) => ac.id === tokens[1])
      const b = current.accounts.findIndex((ac) => ac.id === tokens[2])
      if (a === -1 || b === -1) return current
      ok = true
      // biome-ignore lint/style/noNonNullAssertion: a,b validated in-bounds by findIndex above
      const tmp = current.accounts[a]!
      // biome-ignore lint/style/noNonNullAssertion: a,b validated in-bounds by findIndex above
      current.accounts[a] = current.accounts[b]!
      current.accounts[b] = tmp
      return current
    }, storePaths(ctx))

    if (!ok) {
      return {
        command: 'openai-account',
        text: '## Invalid Order\n\nBoth account IDs must exist.',
        knobs: { accounts: next.accounts.map(accountKnob) },
      }
    }
    log.info('accounts reordered', { a: tokens[1], b: tokens[2] })
    void ctx.refreshSidebar?.().catch(() => {})
    return {
      command: 'openai-account',
      text: `## Accounts Reordered\n\nSwapped positions of \`${tokens[1]}\` and \`${tokens[2]}\`.`,
      knobs: { accounts: next.accounts.map(accountKnob) },
    }
  }

  if (tokens[0] === 'add') {
    if (storage.claustrum?.mode === 'claustrum') {
      return {
        command: 'openai-account',
        text: '## Add Failed\n\nThat account cannot be added while Claustrum mode is active. Run `/openai-account local` first.',
        knobs: {},
      }
    }
    const headless = tokens.includes('--headless')
    const labelTokens = tokens.filter((t) => t !== 'add' && t !== '--headless')
    const label = labelTokens.length > 0 ? labelTokens.join(' ') : undefined
    const { url, instructions, completion } = await (
      ctx.beginAccountLogin ?? beginAccountLogin
    )({
      label,
      headless,
      version: ctx.packageVersion,
    })
    const notify = ctx.notify
    const sessionId = ctx.sessionId

    // Detach completion: the dialog must show the URL before the 30-60s OAuth
    // flow completes. command.execute.before calls cleanAbort right after the
    // dialog is returned, so awaiting inline would deadlock — the URL would
    // never reach the user.
    completion
      .then(async (account) => {
        let rejection: 'claustrum mode' | 'main identity' | undefined
        const withAccountLock =
          ctx.withFallbackAccountLock ??
          (async (_accountId, action) => action())
        await withAccountLock(account.id, async () => {
          const currentStorage = await ctx.loadAccounts(storePaths(ctx))
          if (claustrumMode(currentStorage ?? {}) === 'claustrum') {
            rejection = 'claustrum mode'
            return
          }
          await mutateAccounts((current) => {
            if (
              account.accountId &&
              current.mainAccountId &&
              account.accountId === current.mainAccountId
            ) {
              rejection = 'main identity'
              return current
            }
            upsertAccount(current.accounts, account as OAuthAccount)
            return current
          }, storePaths(ctx))
        })

        if (rejection) {
          const msg =
            rejection === 'claustrum mode'
              ? 'That account cannot be added while Claustrum mode is active. Run `/openai-account local` first.'
              : 'That account is already your main account — not added as a fallback.'
          // Log the internal account id, never the ChatGPT stable id (a sensitive
          // identity from the OAuth claims).
          log.warn(`account add rejected (${rejection})`, {
            id: account.id,
            sessionId,
          })
          notify?.({
            command: 'openai-account',
            text: `## Add Failed\n\n${msg}`,
            knobs: {},
          })
          return
        }

        log.info('account added', {
          id: account.id,
          label: account.label,
        })
        ctx.refreshSidebar?.().catch(() => {})

        notify?.({
          command: 'openai-account',
          text: `## Account Added\n\nAdded account \`${account.id}\`${account.label ? ` ("${account.label}")` : ''}.\n\nRun \`/openai-account\` to confirm.`,
          knobs: {},
        })
      })
      .catch((err: unknown) => {
        const message =
          err instanceof Error ? err.message : String(err ?? 'unknown error')
        log.warn('account add failed', { error: message, sessionId })
        notify?.({
          command: 'openai-account',
          text: `## Add Failed\n\nAccount add failed: ${message}`,
          knobs: {},
        })
      })

    if (headless) {
      const userCode =
        instructions.match(/Enter code: (.+)/)?.[1] ?? instructions
      return {
        command: 'openai-account',
        text: `## Device Code\n\n1. Open this verification URL:\n\n${url}\n\n2. Enter the code: **${userCode}**\n\n${instructions}\n\nThe account will be added automatically — run \`/openai-account\` to confirm.`,
        knobs: { verificationUrl: url, userCode, instructions },
      }
    }

    return {
      command: 'openai-account',
      text: `## Add OpenAI Account\n\nOpen this URL and complete sign-in:\n\n${url}\n\n${instructions}\n\nThe account will be added automatically — run \`/openai-account\` to confirm.`,
      knobs: { url, instructions },
    }
  }

  return {
    command: 'openai-account',
    text: '## Account Commands\n\n- `/openai-account claustrum` — enter Claustrum mode\n- `/openai-account local` — leave Claustrum mode\n- `/openai-account add [label]` — add a new account\n- `/openai-account enable <id>` — enable a fallback\n- `/openai-account disable <id>` — disable a fallback\n- `/openai-account remove <id>` — remove\n- `/openai-account order <a> <b>` — swap fallback positions\n\nRouting modes are `main-first`, `fallback-first`, and `sticky-balanced`. `/openai-routing reset` clears the current session pin.',
    knobs: {
      accounts: accounts.map(accountKnob),
      claustrumMode: claustrumMode(storage),
    },
  }
}

async function executeRoutingCommand(
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const storage = (await ctx.loadAccounts(storePaths(ctx))) ?? {
    version: 1 as const,
    accounts: [],
  }
  const currentMode: RoutingMode = storage.routing?.mode ?? 'main-first'

  if (tokens.length === 1 && tokens[0] === 'reset') {
    if (!ctx.sessionId) {
      return {
        command: 'openai-routing',
        text: '## OpenAI Routing Reset\n\nNo current session is available, so no pin was changed.',
        knobs: { mode: currentMode },
      }
    }
    if (!ctx.clearStickyRouting) {
      return {
        command: 'openai-routing',
        text: '## OpenAI Routing Reset\n\nThis runtime cannot clear the current session pin.',
        knobs: { mode: currentMode },
      }
    }
    await ctx.clearStickyRouting(ctx.sessionId)
    log.info('routing session pin cleared')
    return {
      command: 'openai-routing',
      text: "## OpenAI Routing Reset\n\nThis session's pin was cleared. The next request may choose the same account if it remains the best selection.",
      knobs: { mode: currentMode },
    }
  }

  if (
    tokens.length === 1 &&
    (tokens[0] === 'main-first' ||
      tokens[0] === 'fallback-first' ||
      tokens[0] === 'sticky-balanced')
  ) {
    const mode = tokens[0] as RoutingMode
    // Scalar-field write MUST go through mutateAccounts (read-fresh under lock,
    // authoritative rewrite). A stale saveAccounts here would union its stale
    // account list back over disk and resurrect a concurrently-removed account
    // — re-writing that account's secrets into the state file (credential leak).
    await mutateAccounts((current) => {
      current.routing = { ...(current.routing ?? {}), mode }
      return current
    }, storePaths(ctx))
    log.info('routing mode changed', { mode })
    return {
      command: 'openai-routing',
      text: `## OpenAI Routing Updated\n\nMode: \`${mode}\`\n- ${routingDescription(mode)}\n\nUsage: \`/openai-routing\`, \`/openai-routing main-first\`, \`/openai-routing fallback-first\`, or \`/openai-routing sticky-balanced\`.`,
      knobs: { mode },
    }
  }

  const stickyPin =
    currentMode === 'sticky-balanced' && ctx.sessionId
      ? await ctx.getStickyRouting?.(ctx.sessionId)
      : undefined
  const stickyPinDescription =
    currentMode === 'sticky-balanced'
      ? stickyPin
        ? `\n- Session pin: \`${stickyPin}\`. Use \`/openai-routing reset\` to clear it.`
        : '\n- Session pin: none yet. A request will choose one when a usable account is available.'
      : ''

  return {
    command: 'openai-routing',
    text: `## OpenAI Routing\n\n- Mode: \`${currentMode}\`\n- ${routingDescription(currentMode)}${stickyPinDescription}\n\nUsage: \`/openai-routing\`, \`/openai-routing main-first\`, \`/openai-routing fallback-first\`, or \`/openai-routing sticky-balanced\`.`,
    knobs: { mode: currentMode },
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

type ResetCommandContext = CommandContext &
  Required<
    Pick<
      CommandContext,
      | 'resolveResetTarget'
      | 'fetchImpl'
      | 'now'
      | 'randomUUID'
      | 'refreshResetTargetQuota'
    >
  >

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

function decodeResetArg(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    return decodeURIComponent(value)
  } catch {
    return undefined
  }
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

function renderResetAccountList(rows: readonly ResetPreviewRow[]): string {
  const lines = [
    '## Reset credits',
    '',
    'Select an account to fetch a fresh confirmation preview:',
    '',
  ]
  for (const row of rows) {
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
    lines.push(
      `- **${row.label}** (\`${row.accountKey}\`) — ${usage}; ${credits}; ${status}`,
    )
  }
  lines.push('')
  lines.push('Command: `/openai-reset select <encodedAccountKey>`')
  return lines.join('\n')
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
    lines.push(
      `Confirm: \`/openai-reset confirm ${encodeURIComponent(row.accountKey)} ${encodeURIComponent(row.chatgptAccountId)}\``,
    )
  } else {
    lines.push(`Cannot reset: **${row.reason ?? 'not eligible'}**`)
  }
  return lines.join('\n')
}

function resetResultPayload(
  accountKey: string,
  code: string,
  text: string,
  knobs: Record<string, unknown> = {},
): OpenDialogPayload {
  return {
    command: OPENAI_RESET_COMMAND_NAME,
    text,
    knobs: { stage: 'result', accountKey, code, ...knobs },
  }
}

function resetErrorPayload(
  accountKey: string,
  error: unknown,
  boundChatgptAccountId?: string,
): OpenDialogPayload {
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
): Promise<OpenDialogPayload> {
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
    const retryCommand = boundChatgptAccountId
      ? `/openai-reset retry ${encodeURIComponent(accountKey)} ${encodeURIComponent(boundChatgptAccountId)}`
      : '/openai-reset'
    return resetResultPayload(
      accountKey,
      code,
      `## Reset credit result\n\nAccount: **${result.target.label}** (\`${accountKey}\`)\n\nThe redemption outcome is unknown (\`${code}\`).\n\nRetry with \`${retryCommand}\`. A retry within five minutes reuses the same request and credit identifiers; this does not prove the server did nothing.`,
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

async function executeResetCommand(
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const missingDeps = [
    ctx.resolveResetTarget ? undefined : 'resolveResetTarget',
    ctx.fetchImpl ? undefined : 'fetchImpl',
    ctx.now ? undefined : 'now',
    ctx.randomUUID ? undefined : 'randomUUID',
    ctx.refreshResetTargetQuota ? undefined : 'refreshResetTargetQuota',
  ].filter((name): name is string => name !== undefined)
  if (missingDeps.length > 0) {
    log.warn('reset command dependencies unwired', { missingDeps })
    return {
      command: OPENAI_RESET_COMMAND_NAME,
      text: '## Reset credit\n\nUnavailable: reset command runtime dependencies are not wired.',
      knobs: {},
    }
  }
  const resetCtx = ctx as ResetCommandContext

  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const action = tokens[0]
  if (!action || action === 'refresh') {
    const storage = await ctx.loadAccounts(storePaths(ctx))
    const accountKeys = [
      'main',
      ...(storage?.accounts ?? [])
        .filter(
          (account) => account.enabled !== false && account.type === 'oauth',
        )
        .map((account) => account.id),
    ]
    log.debug('reset accounts stage requested', { accountKeys })
    const accounts = await Promise.all(
      accountKeys.map((accountKey) =>
        buildResetPreviewRow(accountKey, resetCtx),
      ),
    )
    log.debug('reset accounts stage built', {
      rows: accounts.map((row) => ({
        accountKey: row.accountKey,
        eligible: row.eligible,
        reason: row.reason,
        usedPercent: row.usedPercent,
        availableCount: row.availableCount,
        applicableAvailableCount: row.applicableAvailableCount,
      })),
    })
    return {
      command: OPENAI_RESET_COMMAND_NAME,
      text: renderResetAccountList(accounts),
      knobs: { stage: 'accounts', accounts },
    }
  }

  if (action === 'select') {
    const accountKey = decodeResetArg(tokens[1])
    if (
      !accountKey ||
      !isSafeResetAccountKey(accountKey) ||
      tokens.length !== 2
    ) {
      return resetResultPayload(
        '',
        'invalid_command',
        'Usage: `/openai-reset select <encodedAccountKey>`',
      )
    }
    const preview = await buildResetPreviewRow(accountKey, resetCtx)
    if (!preview.eligible) {
      return resetResultPayload(
        accountKey,
        'not_eligible',
        renderResetConfirm(preview),
      )
    }
    return {
      command: OPENAI_RESET_COMMAND_NAME,
      text: renderResetConfirm(preview),
      knobs: { stage: 'confirm', preview },
    }
  }

  if (action === 'confirm' || action === 'retry') {
    const accountKey = decodeResetArg(tokens[1])
    const expectedChatgptAccountId = decodeResetArg(tokens[2])
    if (
      !accountKey ||
      !isSafeResetAccountKey(accountKey) ||
      !expectedChatgptAccountId ||
      tokens.length !== 3
    ) {
      return resetResultPayload(
        accountKey ?? '',
        'invalid_command',
        `Usage: \`/openai-reset ${action} <encodedAccountKey> <encodedChatgptAccountId>\``,
      )
    }
    log.info('reset redemption decision', { accountKey, action })
    log.debug('reset redemption identity binding', {
      accountKey,
      expectedChatgptAccountId,
    })
    try {
      const result = await runResetCreditRedemption(
        {
          configPath: ctx.accountStoragePath,
          statePath: ctx.accountStatePath,
          mutateAccountsFn: mutateAccounts,
          loadAccountsFn: ctx.loadAccounts,
          now: resetCtx.now,
          randomUUID: resetCtx.randomUUID,
          fetchImpl: resetCtx.fetchImpl,
          resolveTarget: resetCtx.resolveResetTarget,
          fetchUsage: (target) =>
            whamUsageFn({
              accessToken: target.accessToken,
              fetchImpl: resetCtx.fetchImpl,
              now: resetCtx.now,
              accountId: target.chatgptAccountId,
            }),
          hasActiveRateLimitMark: (key) => ctx.quotaManager.isRateLimited(key),
        },
        {
          accountKey,
          expectedChatgptAccountId,
          retry: action === 'retry',
        },
      )
      log.info('reset redemption outcome', {
        accountKey,
        code: result.outcome.kind,
      })
      return renderResetCoordinatorResult(
        result,
        resetCtx,
        expectedChatgptAccountId,
      )
    } catch (error) {
      const payload = resetErrorPayload(
        accountKey,
        error,
        expectedChatgptAccountId,
      )
      log.info('reset redemption outcome', {
        accountKey,
        code: payload.knobs.code,
      })
      return payload
    }
  }

  return resetResultPayload(
    '',
    'invalid_command',
    'Usage: `/openai-reset` | `/openai-reset select <encodedAccountKey>` | `/openai-reset confirm <encodedAccountKey> <encodedChatgptAccountId>` | `/openai-reset retry <encodedAccountKey> <encodedChatgptAccountId>` | `/openai-reset refresh`',
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Knob keys that must never cross the RPC boundary.
 *
 * These are the credential fields on the stored account types plus the generic
 * secret names. `authHeader` is included because an API-key account can carry a
 * full `Authorization` value in it.
 */
const CREDENTIAL_KNOB_KEYS = new Set([
  'access',
  'refresh',
  'apikey',
  'authheader',
  'password',
  'secret',
])

function isCredentialKnobKey(key: string) {
  const normalized = key.toLowerCase().replace(/[-_]/g, '')
  if (CREDENTIAL_KNOB_KEYS.has(normalized)) return true
  // No legitimate knob ends in "token"; a stored access/refresh token reaching a
  // knob under any name is a leak regardless of what it is called.
  return normalized.endsWith('token')
}

/**
 * Strip credential-shaped fields from a dialog payload's knobs.
 *
 * Knobs are returned across the loopback RPC and JSON-serialized to the TUI, so
 * a knob is a published surface. Individual commands project their own knobs
 * deliberately (see accountKnob), but this is the boundary backstop: a future
 * command that returns a stored object directly cannot leak credentials even if
 * the projection is forgotten, because nothing credential-shaped survives here.
 *
 * Scrub rather than throw. A rejected dialog is a visible outage for a live
 * command, while a scrubbed one keeps working with the leak removed; the warning
 * is what gets the projection fixed. Recurses into nested objects and arrays,
 * since the account list arrives as an array of records.
 */
// Exported for direct testing: no command currently returns an unprojected knob,
// so a test driven through buildDialogPayload would pass whether or not the
// scrub runs. Testing the mechanism itself is what actually has teeth.
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
    if (isCredentialKnobKey(key)) {
      found.push(`${path}.${key}`)
      continue
    }
    result[key] = scrubKnobs(entry, `${path}.${key}`, found)
  }
  return result
}

export async function buildDialogPayload(
  command: CommandModalName,
  args: string,
  ctx: CommandContext,
  hostBodies: HostCommandBodies = {},
): Promise<OpenDialogPayload> {
  const payload = await buildDialogPayloadUnchecked(
    command,
    args,
    ctx,
    hostBodies,
  )
  const found: string[] = []
  const knobs = scrubKnobs(payload.knobs, 'knobs', found) as Record<
    string,
    unknown
  >
  if (found.length > 0) {
    // Names only — never the values, which are the credentials themselves.
    log.warn('credential-shaped knob stripped before RPC', {
      command,
      fields: found,
    })
    return { ...payload, knobs }
  }
  return payload
}

async function buildDialogPayloadUnchecked(
  command: CommandModalName,
  args: string,
  ctx: CommandContext,
  hostBodies: HostCommandBodies,
): Promise<OpenDialogPayload> {
  switch (command) {
    case 'openai-quota':
      return executeQuotaCommand(ctx)
    case 'openai-account':
      return executeAccountCommand(args, ctx)
    case 'openai-routing':
      return executeRoutingCommand(args, ctx)
    case 'openai-reset':
      return executeResetCommand(args, ctx)
    default: {
      // Commands the core does not own. The host that registered them supplies
      // the body; a host that did not register one cannot reach this line,
      // because its command list never offers the name.
      const hostBody = hostBodies[command]
      if (!hostBody) throw new Error(`unhandled command: ${command}`)
      return hostBody(args, ctx)
    }
  }
}

export async function applyCommand(
  request: ApplyRequest,
  ctx: CommandContext,
  hostBodies: HostCommandBodies = {},
): Promise<ApplyResult> {
  const payload = await buildDialogPayload(
    request.command,
    request.arguments,
    ctx,
    hostBodies,
  )
  return { text: payload.text, knobs: payload.knobs }
}
