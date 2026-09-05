import { getSettings } from './config'
import {
  claustrumMode,
  DEFAULT_KILLSWITCH_THRESHOLDS,
  type loadAccounts as defaultLoadAccounts,
  isSafeResetAccountKey,
  type KillswitchConfig,
  mutateAccounts,
  type OAuthAccount,
  type RoutingMode,
  readConfigRosterIds,
} from './core/accounts'
import type { FallbackAccount } from './core/accounts.ts'
import type { CacheKeepManager, CacheKeepWindow } from './core/cachekeep'
import type { CustodyInertReason } from './core/custody-state.ts'
import type { TransitionResult } from './core/custody-transition.ts'
import { beginAccountLogin, upsertAccount } from './core/oauth'
import { whamUsageFn } from './core/provider'
import type { QuotaManager } from './core/quota-manager'
import type { RefreshAllQuotaResult } from './core/refresh-all-quota'
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
} from './core/reset-credits'
import { createLogger, setLogLevel } from './logger'
import type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
  OpenDialogPayload,
} from './rpc/protocol'
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

export interface CommandContext {
  accountStoragePath: string
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
  setCacheKeepWindow?: (window: CacheKeepWindow | undefined) => void
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
  enterClaustrumMode?: () => Promise<TransitionResult>
  leaveClaustrumMode?: () => Promise<void>
  withFallbackAccountLock: <T>(
    accountId: string,
    action: () => Promise<T>,
  ) => Promise<T>
  checkUsableCustodyBinding?: (
    account: OAuthAccount,
  ) => Promise<
    | { ready: true; accountId: string }
    | { ready: false; reason: CustodyInertReason }
  >
}

export interface ResetTargetIdentity {
  accountKey: string
  label: string
  accessToken: string
  chatgptAccountId?: string
  onAuthFailure?: (status: number) => Promise<void>
}

const log = createLogger('commands')

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
  const storage = (await ctx.loadAccounts(ctx.accountStoragePath)) ?? {
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
    const nextStorage = (await ctx.loadAccounts(ctx.accountStoragePath)) ?? {
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
    const nextStorage = (await ctx.loadAccounts(ctx.accountStoragePath)) ?? {
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
    let refusal: CustodyInertReason | undefined
    let found = false
    const next = await ctx.withFallbackAccountLock(targetId, async () => {
      const current = await ctx.loadAccounts(ctx.accountStoragePath)
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
        }, ctx.accountStoragePath)
      }
      return mutateAccounts((latest) => {
        const account = latest.accounts.find(
          (candidate) => candidate.id === targetId,
        )
        if (!account) return latest
        found = true
        account.enabled = enabled
        return latest
      }, ctx.accountStoragePath)
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

  if (tokens.length === 0) {
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
      ctx.accountStoragePath,
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
    }, ctx.accountStoragePath)

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
    const headless = tokens.includes('--headless')
    const labelTokens = tokens.filter((t) => t !== 'add' && t !== '--headless')
    const label = labelTokens.length > 0 ? labelTokens.join(' ') : undefined
    const { url, instructions, completion } = await (
      ctx.beginAccountLogin ?? beginAccountLogin
    )({
      label,
      headless,
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
        await ctx.withFallbackAccountLock(account.id, async () => {
          const currentStorage = await ctx.loadAccounts(ctx.accountStoragePath)
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
          }, ctx.accountStoragePath)
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
  const storage = (await ctx.loadAccounts(ctx.accountStoragePath)) ?? {
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
    }, ctx.accountStoragePath)
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

async function executeKillswitchCommand(
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const storage = (await ctx.loadAccounts(ctx.accountStoragePath)) ?? {
    version: 1 as const,
    accounts: [],
  }
  const config: KillswitchConfig = storage.killswitch ?? {}
  const accountIds = (storage.accounts ?? [])
    .filter((a) => a.enabled !== false)
    .map((a) => a.id)

  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean)

  if (tokens.length === 0) {
    // Status
    const enabled = config.enabled === true
    const lines = ['## Killswitch', '', `Status: **${enabled ? 'ON' : 'OFF'}**`]
    if (enabled) {
      lines.push('')
      lines.push('| Account | primary threshold | secondary threshold |')
      lines.push('| ------- | ------------ | ------------ |')
      const mainT = config.main ?? {}
      const fh =
        mainT.primary ?? mainT['5h'] ?? DEFAULT_KILLSWITCH_THRESHOLDS.primary
      const sd =
        mainT.secondary ??
        mainT['1w'] ??
        DEFAULT_KILLSWITCH_THRESHOLDS.secondary
      lines.push(`| main | ≥ ${fh}% | ≥ ${sd}% |`)
      for (const id of accountIds) {
        const t = config.accounts?.[id] ?? config.main ?? {}
        const afh =
          t.primary ?? t['5h'] ?? DEFAULT_KILLSWITCH_THRESHOLDS.primary
        const asd =
          t.secondary ?? t['1w'] ?? DEFAULT_KILLSWITCH_THRESHOLDS.secondary
        lines.push(`| ${id} | ≥ ${afh}% | ≥ ${asd}% |`)
      }
    }
    lines.push('')
    lines.push(
      'Commands: `/openai-killswitch on` | `/openai-killswitch off` | `/openai-killswitch set <acct>:<5h>,<1w> ...`',
    )
    return {
      command: 'openai-killswitch',
      text: lines.join('\n'),
      knobs: { config, accountIds },
    }
  }

  if (tokens[0] === 'on') {
    const updated: KillswitchConfig = {
      ...config,
      enabled: true,
      main: config.main ?? {
        primary: DEFAULT_KILLSWITCH_THRESHOLDS.primary,
        secondary: DEFAULT_KILLSWITCH_THRESHOLDS.secondary,
      },
    }
    await mutateAccounts((current) => {
      current.killswitch = updated
      return current
    }, ctx.accountStoragePath)
    log.info('killswitch enabled')
    return {
      command: 'openai-killswitch',
      text: '## Killswitch Enabled',
      knobs: { config: updated, accountIds },
    }
  }

  if (tokens[0] === 'off') {
    const updated: KillswitchConfig = { ...config, enabled: false }
    await mutateAccounts((current) => {
      current.killswitch = updated
      return current
    }, ctx.accountStoragePath)
    log.info('killswitch disabled')
    return {
      command: 'openai-killswitch',
      text: '## Killswitch Disabled',
      knobs: { config: updated, accountIds },
    }
  }

  if (tokens[0] === 'set' && tokens.length > 1) {
    const updated: KillswitchConfig = {
      ...config,
      enabled: true,
      accounts: { ...(config.accounts ?? {}) },
    }
    for (let i = 1; i < tokens.length; i++) {
      const match = tokens[i]?.match(/^([^:]+):(\d+),(\d+)$/)
      if (!match) continue
      const [, acct, fhStr, sdStr] = match as RegExpMatchArray &
        [string, string, string, string]
      const thresholds = {
        primary: Number.parseInt(fhStr, 10),
        secondary: Number.parseInt(sdStr, 10),
      }
      if (acct === 'main') {
        updated.main = thresholds
      } else if (acct === 'all') {
        updated.main = thresholds
        for (const id of accountIds) {
          // biome-ignore lint/style/noNonNullAssertion: accounts initialized above in the same branch
          updated.accounts![id] = thresholds
        }
      } else {
        // biome-ignore lint/style/noNonNullAssertion: accounts initialized above in the same branch
        updated.accounts![acct] = thresholds
      }
    }
    await mutateAccounts((current) => {
      current.killswitch = updated
      return current
    }, ctx.accountStoragePath)
    log.info('killswitch thresholds updated', { count: tokens.length - 1 })
    return {
      command: 'openai-killswitch',
      text: '## Killswitch Updated',
      knobs: { config: updated, accountIds },
    }
  }

  return {
    command: 'openai-killswitch',
    text: 'Usage: `/openai-killswitch`, `/openai-killswitch on`, `/openai-killswitch off`, `/openai-killswitch set <acct>:<5h>,<1w> ...`',
    knobs: { config, accountIds },
  }
}

async function executeDumpCommand(
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const settings = getSettings()
  const currentEnabled = settings.dump

  if (tokens.length === 0) {
    return {
      command: 'openai-dump',
      text: `## Request Dump\n\n- Enabled: ${currentEnabled ? 'ON' : 'OFF'}\n- Directory: ${settings.dumpDir}\n\nUsage: \`/openai-dump on\` or \`/openai-dump off\``,
      knobs: { enabled: currentEnabled },
    }
  }

  if (tokens[0] === 'on') {
    // Persist the dump toggle via mutateAccounts (authoritative, no stale union).
    await mutateAccounts((current) => {
      current.dump = { ...(current.dump ?? {}), enabled: true }
      return current
    }, ctx.accountStoragePath)
    log.info('request dump enabled')
    return {
      command: 'openai-dump',
      text: `## Request Dump Enabled\n\nDump directory: ${settings.dumpDir}\n\nWarning: body dumps may contain prompt/session content. Turn this off after debugging.`,
      knobs: { enabled: true },
    }
  }

  if (tokens[0] === 'off') {
    await mutateAccounts((current) => {
      current.dump = { ...(current.dump ?? {}), enabled: false }
      return current
    }, ctx.accountStoragePath)
    log.info('request dump disabled')
    return {
      command: 'openai-dump',
      text: '## Request Dump Disabled',
      knobs: { enabled: false },
    }
  }

  return {
    command: 'openai-dump',
    text: `Usage: \`/openai-dump\`, \`/openai-dump on\`, or \`/openai-dump off\`.`,
    knobs: { enabled: currentEnabled },
  }
}

async function executeLoggingCommand(
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const validLevels = ['error', 'warn', 'info', 'debug', 'trace']

  if (tokens.length === 0) {
    // Show current level — read from the module state by probing with a reset
    // We report the level stored in the config
    const storage = await ctx.loadAccounts(ctx.accountStoragePath)
    const level = (storage?.logging?.level as string | undefined) ?? 'info'
    return {
      command: 'openai-logging',
      text: `## Logging\n\n- Level: \`${level}\`\n\nValid levels: ${validLevels.map((l) => `\`${l}\``).join(', ')}\n\nUsage: \`/openai-logging <level>\``,
      knobs: { level },
    }
  }

  const levelArg = tokens[0]
  if (levelArg && validLevels.includes(levelArg)) {
    const level = levelArg
    // Call setLogLevel so the log-level change takes effect immediately without a restart.
    setLogLevel(level as 'error' | 'warn' | 'info' | 'debug' | 'trace')

    // Persist via mutateAccounts (authoritative, no stale union).
    await mutateAccounts((current) => {
      current.logging = { ...(current.logging ?? {}), level }
      return current
    }, ctx.accountStoragePath)
    log.info('log level changed', { level })

    return {
      command: 'openai-logging',
      text: `## Logging Updated\n\nLevel set to \`${level}\`.`,
      knobs: { level },
    }
  }

  return {
    command: 'openai-logging',
    text: `## Invalid Level\n\nValid levels: ${validLevels.map((l) => `\`${l}\``).join(', ')}`,
    knobs: { level: 'info' },
  }
}

function parseCacheKeepWindowArg(
  input: string,
):
  | { ok: true; startHour: number; endHour: number }
  | { ok: false; reason: string } {
  const match = /^(\d{1,2})-(\d{1,2})$/.exec(input.trim())
  if (!match) {
    return { ok: false, reason: 'expected HH-HH, e.g. 9-18 or 22-6' }
  }
  const startHour = Number(match[1])
  const endHour = Number(match[2])
  if (
    !Number.isInteger(startHour) ||
    !Number.isInteger(endHour) ||
    startHour < 0 ||
    startHour > 23 ||
    endHour < 0 ||
    endHour > 23 ||
    startHour === endHour
  ) {
    return {
      ok: false,
      reason: 'hours must be integers 0-23 and start ≠ end',
    }
  }
  return { ok: true, startHour, endHour }
}

async function executeCachekeepCommand(
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const mgr = ctx.cacheKeepManager
  const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const storage = await ctx.loadAccounts(ctx.accountStoragePath)
  const enabled = storage?.cachekeep?.enabled === true

  if (tokens.length === 0 || tokens[0] === 'status') {
    if (!mgr) {
      return {
        command: 'openai-cachekeep',
        text: '## Cachekeep\n\nStatus: **not available** (manager not wired)',
        knobs: {},
      }
    }
    const status = mgr.status()
    const liveWindow = status.window
    const windowLabel = liveWindow
      ? `${String(liveWindow.startHour).padStart(2, '0')}-${String(liveWindow.endHour).padStart(2, '0')}`
      : 'always (no window)'
    const lines: string[] = [
      '## Cachekeep',
      '',
      `Status: **${enabled ? 'ON' : 'OFF'}**`,
      `Timer: **${status.running ? 'armed' : 'idle'}**`,
      `Subagent warming: **${storage?.cachekeep?.subagents === true ? 'ON' : 'OFF'}**`,
      `Idle policy: **sustain ${status.sustain ? 'ON' : 'OFF'} (main only)**`,
      `Window: **${windowLabel}**`,
    ]
    lines.push(`Tracked sessions: **${status.tracked}**`)
    if (status.targets.length > 0) {
      lines.push('')
      for (const t of status.targets) {
        const shortSess =
          t.sessionKey.length > 12
            ? `${t.sessionKey.slice(0, 12)}…`
            : t.sessionKey
        const expiresIn = Math.ceil(
          (t.cacheExpiresAt - status.generatedAt) / 1000,
        )
        lines.push(
          `- \`${shortSess}\` (${t.accountId ?? 'main'}) — expires in ${expiresIn}s` +
            (t.lastWarmedAt
              ? `, last warm ${Math.ceil((status.generatedAt - t.lastWarmedAt) / 1000)}s ago`
              : '') +
            (t.backoffUntil && t.backoffUntil > status.generatedAt
              ? `, backoff ${Math.ceil((t.backoffUntil - status.generatedAt) / 1000)}s`
              : ''),
        )
      }
    }
    lines.push('')
    lines.push(
      `TTL: ${Math.round(status.ttlMs / 1000)}s | Lead: ${Math.round(status.leadMs / 1000)}s | Max idle warm: ${Math.round(status.maxIdleWarmMs / 60_000)}min`,
    )
    lines.push('')
    lines.push(
      'Commands: `/openai-cachekeep on` | `/openai-cachekeep off` | `/openai-cachekeep sustain on` | `/openai-cachekeep sustain off` | `/openai-cachekeep HH-HH` | `/openai-cachekeep window clear` | `/openai-cachekeep subagents on` | `/openai-cachekeep subagents off` | `/openai-cachekeep`',
    )
    const lastWarmAt = Math.max(
      0,
      ...status.targets.map((target) => target.lastWarmedAt ?? 0),
    )
    return {
      command: 'openai-cachekeep',
      text: lines.join('\n'),
      knobs: {
        enabled,
        subagents: storage?.cachekeep?.subagents === true,
        sustain: status.sustain,
        window: liveWindow,
        running: status.running,
        tracked: status.tracked,
        lastWarmAt: lastWarmAt || undefined,
        generatedAt: status.generatedAt,
        maxIdleWarmMs: status.maxIdleWarmMs,
        maxSubagentIdleMs: status.maxSubagentIdleMs,
      },
    }
  }

  if (tokens[0] === 'on') {
    if (!mgr) {
      return {
        command: 'openai-cachekeep',
        text: '## Cachekeep\n\nCannot start: manager not wired.',
        knobs: {},
      }
    }
    await mutateAccounts((current) => {
      current.cachekeep = { ...(current.cachekeep ?? {}), enabled: true }
      return current
    }, ctx.accountStoragePath)
    log.info('cachekeep enabled')
    ctx.setCacheKeepEnabled?.(true)
    mgr.start()
    const status = mgr.status()
    const lastWarmAt = Math.max(
      0,
      ...status.targets.map((target) => target.lastWarmedAt ?? 0),
    )
    return {
      command: 'openai-cachekeep',
      text: `## Cachekeep Enabled\n\nTTL: ${Math.round(status.ttlMs / 1000)}s | Max idle warm ${Math.round(status.maxIdleWarmMs / 60_000)}min`,
      knobs: {
        enabled: true,
        subagents: storage?.cachekeep?.subagents === true,
        sustain: status.sustain,
        window: status.window,
        running: status.running,
        tracked: status.tracked,
        lastWarmAt: lastWarmAt || undefined,
        generatedAt: status.generatedAt,
        maxIdleWarmMs: status.maxIdleWarmMs,
        maxSubagentIdleMs: status.maxSubagentIdleMs,
      },
    }
  }

  if (tokens[0] === 'off') {
    await mutateAccounts((current) => {
      current.cachekeep = { ...(current.cachekeep ?? {}), enabled: false }
      return current
    }, ctx.accountStoragePath)
    log.info('cachekeep disabled')
    ctx.setCacheKeepEnabled?.(false)
    mgr?.stop()
    return {
      command: 'openai-cachekeep',
      text: '## Cachekeep Disabled',
      knobs: {
        enabled: false,
        sustain: storage?.cachekeep?.sustain === true,
        running: false,
        tracked: 0,
      },
    }
  }

  if (tokens[0] === 'sustain') {
    const sustainCmd = tokens[1]
    if (tokens.length !== 2 || (sustainCmd !== 'on' && sustainCmd !== 'off')) {
      return {
        command: 'openai-cachekeep',
        text: 'Usage: `/openai-cachekeep sustain on` | `/openai-cachekeep sustain off`',
        knobs: {},
      }
    }
    const value = sustainCmd === 'on'
    await mutateAccounts((current) => {
      current.cachekeep = {
        ...(current.cachekeep ?? {}),
        sustain: value,
      }
      return current
    }, ctx.accountStoragePath)
    log.info(`cachekeep sustain ${value ? 'enabled' : 'disabled'}`)
    ctx.setCacheKeepSustain?.(value)
    const nextStatus = mgr?.status()
    return {
      command: 'openai-cachekeep',
      text: value
        ? '## Cachekeep Sustain Enabled\n\nSustain keeps main-agent sessions warming past the idle cap for this process. Clock windows still apply.\n\nBefore enabling sustain with Magic Context, set a non-expiring `cache_ttl` for models used by main sessions; elapsed-time cold-cache assumptions are no longer valid.'
        : '## Cachekeep Sustain Disabled\n\nMain-agent sessions again stop warming at the configured idle cap.',
      knobs: {
        enabled,
        subagents: storage?.cachekeep?.subagents === true,
        sustain: value,
        window: nextStatus?.window,
        running: nextStatus?.running ?? false,
        tracked: nextStatus?.tracked ?? 0,
        generatedAt: nextStatus?.generatedAt ?? Date.now(),
        maxIdleWarmMs: nextStatus?.maxIdleWarmMs ?? 60 * 60 * 1000,
        maxSubagentIdleMs: nextStatus?.maxSubagentIdleMs ?? 30 * 60 * 1000,
      },
    }
  }

  if (tokens[0] === 'subagents') {
    const subCmd = tokens[1] as string | undefined
    if (!subCmd || (subCmd !== 'on' && subCmd !== 'off')) {
      return {
        command: 'openai-cachekeep',
        text: 'Usage: `/openai-cachekeep subagents on` | `/openai-cachekeep subagents off`',
        knobs: {},
      }
    }
    const value = subCmd === 'on'
    await mutateAccounts((current) => {
      current.cachekeep = {
        ...(current.cachekeep ?? {}),
        subagents: value,
      }
      return current
    }, ctx.accountStoragePath)
    log.info(
      value
        ? 'cachekeep subagent warming enabled'
        : 'cachekeep subagent warming disabled',
    )
    ctx.setCacheKeepSubagents?.(value)
    const nextStatus = mgr?.status()
    return {
      command: 'openai-cachekeep',
      text: `## Cachekeep Subagent Warming\n\nSubagent warming: **${value ? 'ON' : 'OFF'}**`,
      knobs: {
        enabled,
        subagents: value,
        sustain: nextStatus?.sustain ?? storage?.cachekeep?.sustain === true,
        window: nextStatus?.window,
        running: nextStatus?.running ?? false,
        tracked: nextStatus?.tracked ?? 0,
        generatedAt: nextStatus?.generatedAt ?? Date.now(),
        maxIdleWarmMs: nextStatus?.maxIdleWarmMs ?? 60 * 60 * 1000,
        maxSubagentIdleMs: nextStatus?.maxSubagentIdleMs ?? 30 * 60 * 1000,
      },
    }
  }

  // `/openai-cachekeep window clear` (or `window off`) drops any persisted
  // window so cachekeep returns to the legacy "always warm" behavior.
  if (tokens[0] === 'window') {
    const sub = tokens[1]
    if (sub === 'clear' || sub === 'off') {
      await mutateAccounts((current) => {
        if (current.cachekeep) {
          delete current.cachekeep.startHour
          delete current.cachekeep.endHour
        }
        return current
      }, ctx.accountStoragePath)
      ctx.setCacheKeepWindow?.(undefined)
      log.info('cachekeep window cleared')
      const nextStatus = mgr?.status()
      return {
        command: 'openai-cachekeep',
        text: '## Cachekeep Window Cleared\n\nCachekeep will now warm on every tick (within idle caps).',
        knobs: {
          enabled,
          subagents: storage?.cachekeep?.subagents === true,
          sustain: nextStatus?.sustain ?? storage?.cachekeep?.sustain === true,
          window: undefined,
          running: nextStatus?.running ?? false,
          tracked: nextStatus?.tracked ?? 0,
          generatedAt: nextStatus?.generatedAt ?? Date.now(),
          maxIdleWarmMs: nextStatus?.maxIdleWarmMs ?? 60 * 60 * 1000,
          maxSubagentIdleMs: nextStatus?.maxSubagentIdleMs ?? 30 * 60 * 1000,
        },
      }
    }
    return {
      command: 'openai-cachekeep',
      text: 'Usage: `/openai-cachekeep window clear`',
      knobs: {},
    }
  }

  // Top-level `HH-HH` parses as a window set (e.g. `/openai-cachekeep 9-18`).
  const hhToken = tokens[0]
  if (hhToken && /^\d{1,2}-\d{1,2}$/.test(hhToken)) {
    const parsed = parseCacheKeepWindowArg(hhToken)
    if (!parsed.ok) {
      return {
        command: 'openai-cachekeep',
        text: `## Cachekeep Window Invalid\n\n${parsed.reason}`,
        knobs: {},
      }
    }
    const { startHour, endHour } = parsed
    await mutateAccounts((current) => {
      current.cachekeep = {
        ...(current.cachekeep ?? {}),
        startHour,
        endHour,
      }
      return current
    }, ctx.accountStoragePath)
    ctx.setCacheKeepWindow?.({ startHour, endHour })
    log.info('cachekeep window set', { startHour, endHour })
    const nextStatus = mgr?.status()
    const hhLabel = `${String(startHour).padStart(2, '0')}-${String(endHour).padStart(2, '0')}`
    return {
      command: 'openai-cachekeep',
      text: `## Cachekeep Window Set\n\nWarming limited to **${hhLabel}** local hours.`,
      knobs: {
        enabled,
        subagents: storage?.cachekeep?.subagents === true,
        sustain: nextStatus?.sustain ?? storage?.cachekeep?.sustain === true,
        window: { startHour, endHour },
        running: nextStatus?.running ?? false,
        tracked: nextStatus?.tracked ?? 0,
        generatedAt: nextStatus?.generatedAt ?? Date.now(),
        maxIdleWarmMs: nextStatus?.maxIdleWarmMs ?? 60 * 60 * 1000,
        maxSubagentIdleMs: nextStatus?.maxSubagentIdleMs ?? 30 * 60 * 1000,
      },
    }
  }

  return {
    command: 'openai-cachekeep',
    text: 'Usage: `/openai-cachekeep`, `/openai-cachekeep on`, `/openai-cachekeep off`, `/openai-cachekeep sustain on`, `/openai-cachekeep sustain off`, `/openai-cachekeep HH-HH`, `/openai-cachekeep window clear`, `/openai-cachekeep subagents on`, `/openai-cachekeep subagents off`',
    knobs: {},
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
    const storage = await ctx.loadAccounts(ctx.accountStoragePath)
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
): Promise<OpenDialogPayload> {
  const payload = await buildDialogPayloadUnchecked(command, args, ctx)
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
): Promise<OpenDialogPayload> {
  switch (command) {
    case 'openai-quota':
      return executeQuotaCommand(ctx)
    case 'openai-account':
      return executeAccountCommand(args, ctx)
    case 'openai-routing':
      return executeRoutingCommand(args, ctx)
    case 'openai-killswitch':
      return executeKillswitchCommand(args, ctx)
    case 'openai-dump':
      return executeDumpCommand(args, ctx)
    case 'openai-logging':
      return executeLoggingCommand(args, ctx)
    case 'openai-cachekeep':
      return executeCachekeepCommand(args, ctx)
    case 'openai-reset':
      return executeResetCommand(args, ctx)
    default:
      throw new Error(`unhandled command: ${command}`)
  }
}

export async function applyCommand(
  request: ApplyRequest,
  ctx: CommandContext,
): Promise<ApplyResult> {
  const payload = await buildDialogPayload(
    request.command,
    request.arguments,
    ctx,
  )
  return { text: payload.text, knobs: payload.knobs }
}
