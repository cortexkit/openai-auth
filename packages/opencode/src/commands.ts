import { getSettings } from './config'
import {
  DEFAULT_KILLSWITCH_THRESHOLDS,
  type loadAccounts as defaultLoadAccounts,
  saveAccounts as defaultSaveAccounts,
  type KillswitchConfig,
  mutateAccounts,
  type OAuthAccount,
  type RoutingMode,
} from './core/accounts'
import type { CacheKeepManager } from './core/cachekeep'
import { beginAccountLogin, upsertAccount } from './core/oauth'
import type { QuotaManager } from './core/quota-manager'
import type { RefreshAllQuotaResult } from './core/refresh-all-quota'
import { createLogger, setLogLevel } from './logger'
import type {
  ApplyRequest,
  ApplyResult,
  CommandModalName,
  OpenDialogPayload,
} from './rpc/protocol'

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

export const MODAL_COMMANDS: CommandModalName[] = [
  'openai-quota',
  'openai-account',
  'openai-routing',
  'openai-killswitch',
  'openai-dump',
  'openai-logging',
  'openai-cachekeep',
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
}

const log = createLogger('commands')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function routingDescription(mode: RoutingMode) {
  return mode === 'fallback-first'
    ? 'Try usable fallback accounts before the main account.'
    : 'Try the main account first. Use fallback accounts only when required.'
}

// ---------------------------------------------------------------------------
// Per-command execution functions
// ---------------------------------------------------------------------------

async function executeQuotaCommand(
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const refreshResults = await ctx.refreshAllQuota?.()
  const mainEntry = ctx.quotaManager.getMain()
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
          `- ${key}: ${bar} ${pct}% used (${Math.round(w.remainingPercent)}% remaining)`,
        )
      }
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
            `  - ${key}: ${pct}% used (${Math.round(w.remainingPercent)}% remaining)`,
          )
        }
      }
    }
  }

  if (refreshResults?.length) {
    const failures = refreshResults.filter((r) => !r.ok)
    if (failures.length > 0) {
      lines.push('')
      for (const f of failures) {
        lines.push(
          `⚠ ${f.account}: could not fetch (${f.error ?? 'unknown error'})`,
        )
      }
    }
  }

  return { command: 'openai-quota', text: lines.join('\n'), knobs: {} }
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

  if (tokens.length === 0) {
    // Show status
    const lines = ['## OpenAI Accounts', '']
    if (accounts.length === 0) {
      lines.push(
        'No accounts configured. Use `/login openai` to add your main account, or `/openai-account add` to add a fallback account.',
      )
    } else {
      const mode: RoutingMode = storage.routing?.mode ?? 'main-first'
      lines.push(`Routing: \`${mode}\` (set with \`/openai-routing\`).`)
      lines.push('')
      for (const a of accounts) {
        const type = (a as { type?: string }).type ?? 'oauth'
        lines.push(`- \`${a.id}\` (${type})`)
      }
    }
    lines.push('')
    lines.push(
      'Commands: `/openai-account add [label]` | `/openai-account remove <id>`',
    )
    return {
      command: 'openai-account',
      text: lines.join('\n'),
      knobs: { accounts },
    }
  }

  if (tokens[0] === 'remove' && tokens[1]) {
    const targetId = tokens[1]
    // Structural edit: route through mutateAccounts so the deletion is written
    // authoritatively. saveAccounts union-merges latest ∪ incoming by id, which
    // would resurrect the removed account from the on-disk `latest` set.
    let removed = false
    const next = await mutateAccounts((current) => {
      const idx = current.accounts.findIndex((a) => a.id === targetId)
      if (idx === -1) return current
      removed = true
      current.accounts.splice(idx, 1)
      return current
    }, ctx.accountStoragePath)

    if (!removed) {
      return {
        command: 'openai-account',
        text: `## Account Not Found\n\nNo account with id \`${targetId}\` exists.`,
        knobs: { accounts: next.accounts },
      }
    }

    log.info('account removed', { id: targetId })
    void ctx.refreshSidebar?.().catch(() => {})

    return {
      command: 'openai-account',
      text: `## Account Removed\n\nRemoved account \`${targetId}\`.`,
      knobs: { accounts: next.accounts },
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
        knobs: { accounts: next.accounts },
      }
    }
    log.info('accounts reordered', { a: tokens[1], b: tokens[2] })
    void ctx.refreshSidebar?.().catch(() => {})
    return {
      command: 'openai-account',
      text: `## Accounts Reordered\n\nSwapped positions of \`${tokens[1]}\` and \`${tokens[2]}\`.`,
      knobs: { accounts: next.accounts },
    }
  }

  if (tokens[0] === 'add') {
    const headless = tokens.includes('--headless')
    const labelTokens = tokens.filter((t) => t !== 'add' && t !== '--headless')
    const label = labelTokens.length > 0 ? labelTokens.join(' ') : undefined
    const { url, instructions, completion } = await beginAccountLogin({
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
        let rejectedAsMain = false
        // Route the add through mutateAccounts: read-modify-write under the lock
        // so a concurrent add/remove cannot clobber this insertion, and so the
        // main-identity check reads the freshest mainAccountId.
        await mutateAccounts((current) => {
          if (
            account.accountId &&
            current.mainAccountId &&
            account.accountId === current.mainAccountId
          ) {
            rejectedAsMain = true
            return current
          }
          upsertAccount(current.accounts, account as OAuthAccount)
          return current
        }, ctx.accountStoragePath)

        if (rejectedAsMain) {
          const msg =
            'That account is already your main account — not added as a fallback.'
          // Log the internal account id, never the ChatGPT stable id (a sensitive
          // identity from the OAuth claims).
          log.warn('account add rejected (main identity)', {
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
    text: '## Account Commands\n\n- `/openai-account` — show accounts\n- `/openai-account add [label]` — add a new account\n- `/openai-account remove <id>` — remove\n- `/openai-account order <a> <b>` — swap fallback positions\n\nRouting is set with `/openai-routing` (main-first / fallback-first).',
    knobs: { accounts },
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

  if (
    tokens.length === 1 &&
    (tokens[0] === 'main-first' || tokens[0] === 'fallback-first')
  ) {
    const mode = tokens[0] as RoutingMode
    storage.routing = { ...(storage.routing ?? {}), mode }
    await defaultSaveAccounts(storage, ctx.accountStoragePath)
    log.info('routing mode changed', { mode })
    return {
      command: 'openai-routing',
      text: `## OpenAI Routing Updated\n\nMode: \`${mode}\`\n- ${routingDescription(mode)}\n\nUsage: \`/openai-routing\`, \`/openai-routing main-first\`, or \`/openai-routing fallback-first\`.`,
      knobs: { mode },
    }
  }

  return {
    command: 'openai-routing',
    text: `## OpenAI Routing\n\n- Mode: \`${currentMode}\`\n- ${routingDescription(currentMode)}\n\nUsage: \`/openai-routing\`, \`/openai-routing main-first\`, or \`/openai-routing fallback-first\`.`,
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
      lines.push('| Account | 5h threshold | 1w threshold |')
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
    storage.killswitch = updated
    await defaultSaveAccounts(storage, ctx.accountStoragePath)
    log.info('killswitch enabled')
    return {
      command: 'openai-killswitch',
      text: '## Killswitch Enabled',
      knobs: { config: updated, accountIds },
    }
  }

  if (tokens[0] === 'off') {
    const updated: KillswitchConfig = { ...config, enabled: false }
    storage.killswitch = updated
    await defaultSaveAccounts(storage, ctx.accountStoragePath)
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
    storage.killswitch = updated
    await defaultSaveAccounts(storage, ctx.accountStoragePath)
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
    // Persist the dump toggle in account storage
    const storage = (await ctx.loadAccounts(ctx.accountStoragePath)) ?? {
      version: 1 as const,
      accounts: [],
    }
    storage.dump = { ...(storage.dump ?? {}), enabled: true }
    await defaultSaveAccounts(storage, ctx.accountStoragePath)
    log.info('request dump enabled')
    return {
      command: 'openai-dump',
      text: `## Request Dump Enabled\n\nDump directory: ${settings.dumpDir}\n\nWarning: body dumps may contain prompt/session content. Turn this off after debugging.`,
      knobs: { enabled: true },
    }
  }

  if (tokens[0] === 'off') {
    const storage = (await ctx.loadAccounts(ctx.accountStoragePath)) ?? {
      version: 1 as const,
      accounts: [],
    }
    storage.dump = { ...(storage.dump ?? {}), enabled: false }
    await defaultSaveAccounts(storage, ctx.accountStoragePath)
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

    // Persist in account storage
    const storage = (await ctx.loadAccounts(ctx.accountStoragePath)) ?? {
      version: 1 as const,
      accounts: [],
    }
    storage.logging = { ...(storage.logging ?? {}), level }
    await defaultSaveAccounts(storage, ctx.accountStoragePath)
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
    const lines: string[] = [
      '## Cachekeep',
      '',
      `Status: **${enabled ? 'ON' : 'OFF'}**`,
      `Timer: **${status.running ? 'armed' : 'idle'}**`,
      `Subagent warming: **${storage?.cachekeep?.subagents === true ? 'ON' : 'OFF'}**`,
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
      'Commands: `/openai-cachekeep on` | `/openai-cachekeep off` | `/openai-cachekeep subagents on` | `/openai-cachekeep subagents off` | `/openai-cachekeep`',
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
    const nextStorage = storage ?? {
      version: 1 as const,
      main: { type: 'opencode' as const, provider: 'openai' as const },
      accounts: [],
    }
    nextStorage.cachekeep = { ...(nextStorage.cachekeep ?? {}), enabled: true }
    await defaultSaveAccounts(nextStorage, ctx.accountStoragePath)
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
    const nextStorage = storage ?? {
      version: 1 as const,
      main: { type: 'opencode' as const, provider: 'openai' as const },
      accounts: [],
    }
    nextStorage.cachekeep = { ...(nextStorage.cachekeep ?? {}), enabled: false }
    await defaultSaveAccounts(nextStorage, ctx.accountStoragePath)
    log.info('cachekeep disabled')
    ctx.setCacheKeepEnabled?.(false)
    mgr?.stop()
    return {
      command: 'openai-cachekeep',
      text: '## Cachekeep Disabled',
      knobs: { enabled: false, running: false, tracked: 0 },
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
    const nextStorage = storage ?? {
      version: 1 as const,
      main: { type: 'opencode' as const, provider: 'openai' as const },
      accounts: [],
    }
    const value = subCmd === 'on'
    nextStorage.cachekeep = {
      ...(nextStorage.cachekeep ?? {}),
      subagents: value,
    }
    await defaultSaveAccounts(nextStorage, ctx.accountStoragePath)
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
    text: 'Usage: `/openai-cachekeep`, `/openai-cachekeep on`, `/openai-cachekeep off`, `/openai-cachekeep subagents on`, `/openai-cachekeep subagents off`',
    knobs: {},
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function buildDialogPayload(
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
