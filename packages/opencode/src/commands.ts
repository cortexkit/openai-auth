/**
 * OpenCode's command surface.
 *
 * The shared command bodies live in the core so both hosts run the same code.
 * What stays here are the four commands whose state belongs to this host's live
 * request loader — the cachekeep manager it owns and the settings it memoizes —
 * plus the wrappers that hand those bodies to the core's entry points. Going
 * through `buildDialogPayload` / `applyCommand` is what guarantees the
 * credential scrubbing runs on every payload, including these four.
 */
import {
  type CommandContext,
  applyCommand as coreApplyCommand,
  buildDialogPayload as coreBuildDialogPayload,
  type HostCommandBodies,
} from '@cortexkit/openai-auth-core'
import {
  type ApplyRequest,
  type ApplyResult,
  type CommandModalName,
  DEFAULT_KILLSWITCH_THRESHOLDS,
  type KillswitchConfig,
  mutateAccounts,
  type OpenDialogPayload,
  setLogLevel,
} from '@cortexkit/openai-auth-core/internal'
import { getSettings, refreshSettings } from './config'
import { createLogger } from './logger'

export {
  type CommandContext,
  MODAL_COMMANDS,
  OPENAI_ACCOUNT_COMMAND_NAME,
  OPENAI_CACHEKEEP_COMMAND_NAME,
  OPENAI_DUMP_COMMAND_NAME,
  OPENAI_KILLSWITCH_COMMAND_NAME,
  OPENAI_LOGGING_COMMAND_NAME,
  OPENAI_QUOTA_COMMAND_NAME,
  OPENAI_RESET_COMMAND_NAME,
  OPENAI_ROUTING_COMMAND_NAME,
  scrubKnobs,
} from '@cortexkit/openai-auth-core'
export {
  type ResetTargetIdentity,
  renderResetCoordinatorResult,
} from '@cortexkit/openai-auth-core/internal'

const log = createLogger('commands')

/** The config/state pair a context describes, in the shape the store takes. */
function storePaths(ctx: CommandContext) {
  return {
    configPath: ctx.accountStoragePath,
    statePath: ctx.accountStatePath,
  }
}

async function executeKillswitchCommand(
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  const storage = (await ctx.loadAccounts(storePaths(ctx))) ?? {
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
    }, storePaths(ctx))
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
    }, storePaths(ctx))
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
    }, storePaths(ctx))
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
    }, storePaths(ctx))
    // The dump gates read memoized settings, so without this the running process
    // keeps dumping nothing while the file says it is on.
    const updated = refreshSettings()
    log.info('request dump enabled')
    return {
      command: 'openai-dump',
      text: `## Request Dump Enabled\n\nDump directory: ${updated.dumpDir}\n\nWarning: body dumps may contain prompt/session content. Turn this off after debugging.`,
      knobs: { enabled: true },
    }
  }

  if (tokens[0] === 'off') {
    await mutateAccounts((current) => {
      current.dump = { ...(current.dump ?? {}), enabled: false }
      return current
    }, storePaths(ctx))
    refreshSettings()
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
    const storage = await ctx.loadAccounts(storePaths(ctx))
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
    }, storePaths(ctx))
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
  const storage = await ctx.loadAccounts(storePaths(ctx))
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
    }, storePaths(ctx))
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
    }, storePaths(ctx))
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
    }, storePaths(ctx))
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
    }, storePaths(ctx))
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
      }, storePaths(ctx))
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
    }, storePaths(ctx))
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

/**
 * The four bodies this host owns, keyed by the command name that reaches them.
 *
 * Handed to the core on every entry so the dispatch stays in one place and the
 * scrubbing applies uniformly; Pi registers none of these and passes nothing.
 */
export const hostCommandBodies: HostCommandBodies = {
  'openai-killswitch': executeKillswitchCommand,
  'openai-dump': executeDumpCommand,
  'openai-logging': executeLoggingCommand,
  'openai-cachekeep': executeCachekeepCommand,
}

export function buildDialogPayload(
  command: CommandModalName,
  args: string,
  ctx: CommandContext,
): Promise<OpenDialogPayload> {
  return coreBuildDialogPayload(command, args, ctx, hostCommandBodies)
}

export function applyCommand(
  request: ApplyRequest,
  ctx: CommandContext,
): Promise<ApplyResult> {
  return coreApplyCommand(request, ctx, hostCommandBodies)
}
