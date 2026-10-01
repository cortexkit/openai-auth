/**
 * OpenCode's `/openai` command.
 *
 * The menu itself is the core's (`createOpenAiMenu`, over the shared command
 * menu); what stays here is what only this host has: the Cache section over
 * the live loader's keep-warm manager, the Diagnostics section over its dump
 * and logging settings, Claustrum mode, reset credits wired to this host's
 * token resolution, and the not-migrated gate.
 *
 * Every payload comes out of the shared seam, which projects accounts field
 * by field and scrubs credential-shaped names, so nothing here builds a
 * payload of its own.
 */
import type { CommandMenuModel } from '@cortexkit/common-auth/commands'
import type { PoolLockSpec, PoolStore } from '@cortexkit/common-auth/store'
import {
  type ApplyRequest,
  type ApplyResult,
  type CacheKeepManager,
  claustrumSection,
  createOpenAiMenu,
  type MenuMigrationState,
  OPENAI_COMMAND_NAME,
  type OpenDialogPayload,
  type ResetTargetIdentity,
  resetCreditsSection,
  sessionSection,
  settingsMutateAccounts,
  writeSettings,
} from '@cortexkit/openai-auth-core'
import {
  type AccountPaths,
  type beginAccountLogin,
  type ClaustrumMode,
  cacheKeepSettings,
  claustrumMode,
  type loadAccounts,
  type OAuthAccount,
  type QuotaManager,
  type RefreshAllQuotaResult,
  setLogLevel,
} from '@cortexkit/openai-auth-core/internal'
import { getSettings, refreshSettings } from './config'
import { poolRemovalRefusal, poolSettingsLocks } from './core/pool-accounts'
import { legacyRefreshLocks } from './core/pool-migration'
import { createLogger } from './logger'
import { pushNotification } from './rpc/notifications'

export { OPENAI_COMMAND_NAME } from '@cortexkit/openai-auth-core'

const log = createLogger('commands')

/** What the `/openai` menu reads and changes in this process. */
export interface OpenCodeMenuContext {
  accountStoragePath: string
  /** Runtime-state file that goes with `accountStoragePath`. */
  accountStatePath: string
  /** Host package version, sent as the version half of the OAuth `User-Agent`. */
  packageVersion: string
  quotaManager: QuotaManager
  loadAccounts: typeof loadAccounts
  /** The pool store the accounts live in. */
  store: () => PoolStore
  /** Whether the install is migrated, and what holds it back when not. */
  migration: () => Promise<MenuMigrationState>
  /** Starts an OAuth account-add flow; injected by the runtime boundary. */
  beginAccountLogin?: typeof beginAccountLogin
  /** Actively poll quota for every account. */
  refreshAllQuota?: () => Promise<RefreshAllQuotaResult[]>
  /** Refresh the sidebar-state file after a change. */
  refreshSidebar?: () => Promise<void>
  /** Re-read the pool so requests route across the changed rows at once. */
  afterWrite?: () => unknown
  cacheKeepManager?: CacheKeepManager | null
  setCacheKeepEnabled?: (enabled: boolean) => void
  setCacheKeepSubagents?: (enabled: boolean) => void
  setCacheKeepSustain?: (enabled: boolean) => void
  setCacheKeepWindow?: (
    window: { startHour: number; endHour: number } | undefined,
  ) => void
  clearStickyRouting?: (sessionId: string) => Promise<boolean>
  getStickyRouting?: (sessionId: string) => Promise<string | undefined>
  resolveResetTarget?: (accountKey: string) => Promise<ResetTargetIdentity>
  refreshResetTargetQuota?: (
    accountKey: string,
  ) => Promise<RefreshAllQuotaResult>
  fetchImpl?: typeof fetch
  now?: () => number
  randomUUID?: () => string
  /** Runs `action` holding row `accountId`'s fallback refresh lock. */
  withFallbackAccountLock?: <T>(
    accountId: string,
    action: () => Promise<T>,
  ) => Promise<T>
  /**
   * Under Claustrum mode, whether the vault serves a usable credential for
   * the account, and which ChatGPT account it signs in as.
   */
  checkUsableCustodyBinding?: (
    account: OAuthAccount,
  ) => Promise<
    { ready: true; accountId: string } | { ready: false; reason: string }
  >
  enterClaustrumMode?: () => Promise<{
    status: 'completed' | 'incomplete' | 'aborted'
    outcomes: Record<string, string>
    reason?: string
  }>
  leaveClaustrumMode?: () => Promise<void>
}

function storePaths(ctx: OpenCodeMenuContext): AccountPaths {
  return {
    configPath: ctx.accountStoragePath,
    statePath: ctx.accountStatePath,
  }
}

async function currentClaustrumMode(
  ctx: OpenCodeMenuContext,
): Promise<ClaustrumMode> {
  return claustrumMode(await ctx.loadAccounts(storePaths(ctx)))
}

function hourLabel(window: { startHour: number; endHour: number }) {
  return `${String(window.startHour).padStart(2, '0')}-${String(window.endHour).padStart(2, '0')}`
}

/** Parses a clock-hour window `HH-HH`, such as `9-18` or `22-6`. */
export function parseCacheKeepWindow(
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
  if (startHour > 23 || endHour > 23 || startHour === endHour) {
    return {
      ok: false,
      reason: 'hours must be integers 0-23 and start ≠ end',
    }
  }
  return { ok: true, startHour, endHour }
}

const SUSTAIN_ON_TEXT =
  'Sustain keeps main-agent sessions warming past the idle cap for this process. Clock windows still apply.\n\nBefore enabling sustain with Magic Context, set a non-expiring `cache_ttl` for models used by main sessions; elapsed-time cold-cache assumptions are no longer valid.'

/** The Cache section: prompt-cache keep-warm, over the live manager. */
function cacheSection(ctx: OpenCodeMenuContext) {
  const write = (edit: (cacheKeep: Record<string, unknown>) => void) =>
    writeSettings(ctx.store(), poolSettingsLocks(storePaths(ctx)), (s) => {
      const cacheKeep = { ...((s.cacheKeep as object | undefined) ?? {}) }
      edit(cacheKeep as Record<string, unknown>)
      s.cacheKeep = cacheKeep
    })
  return {
    title: 'Cache',
    build: async () => {
      const mgr = ctx.cacheKeepManager
      if (!mgr)
        return { lines: ['Cache keep-warm is not available in this process.'] }
      const stored = cacheKeepSettings(await ctx.loadAccounts(storePaths(ctx)))
      const enabled = stored?.enabled === true
      const subagents = stored?.subagents === true
      const status = mgr.status()
      const windowLabel = status.window
        ? hourLabel(status.window)
        : 'always (no window)'
      return {
        lines: [
          `Keep-warm: ${enabled ? 'on' : 'off'}, timer ${status.running ? 'armed' : 'idle'}, ${status.tracked} session(s) tracked.`,
          `Subagent warming: ${subagents ? 'on' : 'off'}. Sustain (main sessions only): ${status.sustain ? 'on' : 'off'}. Window: ${windowLabel}.`,
          `TTL ${Math.round(status.ttlMs / 1000)}s, lead ${Math.round(status.leadMs / 1000)}s, idle cap ${Math.round(status.maxIdleWarmMs / 60_000)}min (subagents ${Math.round(status.maxSubagentIdleMs / 60_000)}min).`,
        ],
        items: status.targets.map((target) => ({
          id: target.sessionKey,
          label:
            target.sessionKey.length > 12
              ? `${target.sessionKey.slice(0, 12)}…`
              : target.sessionKey,
          detail: [
            target.accountId ?? 'main',
            `expires in ${Math.ceil((target.cacheExpiresAt - status.generatedAt) / 1000)}s`,
            ...(target.lastWarmedAt
              ? [
                  `last warm ${Math.ceil((status.generatedAt - target.lastWarmedAt) / 1000)}s ago`,
                ]
              : []),
            ...(target.backoffUntil && target.backoffUntil > status.generatedAt
              ? [
                  `backoff ${Math.ceil((target.backoffUntil - status.generatedAt) / 1000)}s`,
                ]
              : []),
          ].join(' · '),
        })),
        actions: [
          {
            id: 'enabled',
            label: enabled ? 'Turn keep-warm off' : 'Turn keep-warm on',
            knobs: [
              {
                kind: 'toggle' as const,
                id: 'enabled',
                label: 'Keep-warm',
                value: !enabled,
              },
            ],
            run: async ({ values }: { values: Record<string, unknown> }) => {
              const on = values.enabled === true
              await write((cacheKeep) => {
                cacheKeep.enabled = on
              })
              ctx.setCacheKeepEnabled?.(on)
              if (on) mgr.start()
              else mgr.stop()
              log.info(on ? 'cachekeep enabled' : 'cachekeep disabled')
              return on
                ? `Keep-warm is on. TTL ${Math.round(status.ttlMs / 1000)}s, idle cap ${Math.round(status.maxIdleWarmMs / 60_000)}min.`
                : 'Keep-warm is off.'
            },
          },
          {
            id: 'subagents',
            label: subagents
              ? 'Stop warming subagent sessions'
              : 'Warm subagent sessions too',
            knobs: [
              {
                kind: 'toggle' as const,
                id: 'subagents',
                label: 'Subagent warming',
                value: !subagents,
              },
            ],
            run: async ({ values }: { values: Record<string, unknown> }) => {
              const on = values.subagents === true
              await write((cacheKeep) => {
                cacheKeep.subagents = on
              })
              ctx.setCacheKeepSubagents?.(on)
              return `Subagent warming is ${on ? 'on' : 'off'}.`
            },
          },
          {
            id: 'sustain',
            label: status.sustain
              ? 'Stop sustaining main sessions'
              : 'Sustain main sessions past the idle cap',
            knobs: [
              {
                kind: 'toggle' as const,
                id: 'sustain',
                label: 'Sustain',
                value: !status.sustain,
              },
            ],
            run: async ({ values }: { values: Record<string, unknown> }) => {
              const on = values.sustain === true
              await write((cacheKeep) => {
                cacheKeep.sustain = on
              })
              ctx.setCacheKeepSustain?.(on)
              return on
                ? SUSTAIN_ON_TEXT
                : 'Main-agent sessions again stop warming at the configured idle cap.'
            },
          },
          {
            id: 'window',
            label: 'Set the warm window',
            description:
              'Warm only between these local hours, e.g. 9-18 or 22-6. Leave it empty to warm at any hour.',
            knobs: [
              {
                kind: 'text' as const,
                id: 'window',
                label: 'Window (HH-HH)',
                placeholder: '9-18',
                ...(status.window ? { value: hourLabel(status.window) } : {}),
              },
            ],
            run: async ({ values }: { values: Record<string, unknown> }) => {
              const raw = values.window
              if (typeof raw !== 'string' || raw.trim() === '') {
                await write((cacheKeep) => {
                  delete cacheKeep.startHour
                  delete cacheKeep.endHour
                })
                ctx.setCacheKeepWindow?.(undefined)
                return 'Warm window cleared: keep-warm warms at any hour (within idle caps).'
              }
              const parsed = parseCacheKeepWindow(raw)
              if (!parsed.ok)
                return { ok: false, text: `Invalid window: ${parsed.reason}` }
              const { startHour, endHour } = parsed
              await write((cacheKeep) => {
                cacheKeep.startHour = startHour
                cacheKeep.endHour = endHour
              })
              ctx.setCacheKeepWindow?.({ startHour, endHour })
              return `Warming limited to ${hourLabel(parsed)} local hours.`
            },
          },
        ],
      }
    },
  }
}

const LOG_LEVELS = ['error', 'warn', 'info', 'debug', 'trace'] as const

/** The Diagnostics section: request dumps and the log level. */
function diagnosticsSection(ctx: OpenCodeMenuContext) {
  return {
    title: 'Diagnostics',
    build: async () => {
      const settings = getSettings()
      const storage = await ctx.loadAccounts(storePaths(ctx))
      const level = storage?.logging?.level ?? 'info'
      return {
        lines: [
          `Request dumps: ${settings.dump ? 'on' : 'off'}, written to ${settings.dumpDir}.`,
          `Log level: ${level}.`,
        ],
        actions: [
          {
            id: 'dump',
            label: settings.dump
              ? 'Turn request dumps off'
              : 'Turn request dumps on',
            knobs: [
              {
                kind: 'toggle' as const,
                id: 'enabled',
                label: 'Request dumps',
                value: !settings.dump,
              },
            ],
            run: async ({ values }: { values: Record<string, unknown> }) => {
              const on = values.enabled === true
              await writeSettings(
                ctx.store(),
                poolSettingsLocks(storePaths(ctx)),
                (s) => {
                  s.dump = {
                    ...((s.dump as object | undefined) ?? {}),
                    enabled: on,
                  }
                },
              )
              // The dump gates read memoized settings; without this the running
              // process keeps dumping nothing while the file says it is on.
              const updated = refreshSettings()
              log.info(on ? 'request dump enabled' : 'request dump disabled')
              return on
                ? `Request dumps are on, written to ${updated.dumpDir}.\n\nBody dumps may contain prompt and session content. Turn this off after debugging.`
                : 'Request dumps are off.'
            },
          },
          {
            id: 'logging',
            label: 'Set the log level',
            knobs: [
              {
                kind: 'choice' as const,
                id: 'level',
                label: 'Level',
                choices: LOG_LEVELS.map((value) => ({ value, label: value })),
                value: (LOG_LEVELS as readonly string[]).includes(level)
                  ? level
                  : 'info',
              },
            ],
            run: async ({ values }: { values: Record<string, unknown> }) => {
              const next = String(values.level) as (typeof LOG_LEVELS)[number]
              await writeSettings(
                ctx.store(),
                poolSettingsLocks(storePaths(ctx)),
                (s) => {
                  s.logging = {
                    ...((s.logging as object | undefined) ?? {}),
                    level: next,
                  }
                },
              )
              // Takes effect now, without a restart.
              setLogLevel(next)
              log.info('log level changed', { level: next })
              return `Log level set to ${next}.`
            },
          },
        ],
      }
    },
  }
}

/** The accounts a reset credit can be spent on: `main`, then the enabled OAuth rows. */
async function resetAccountKeys(ctx: OpenCodeMenuContext): Promise<string[]> {
  const load = await ctx.store().read()
  const rows = load.status === 'ready' ? load.rows : []
  return [
    ...new Set([
      'main',
      ...rows
        .filter((row) => row.enabled && row.type === 'oauth')
        .map((row) => row.id),
    ]),
  ]
}

/**
 * Enabling a row under Claustrum mode: the vault must serve a usable
 * credential for the account first, checked and recorded under the row's
 * fallback refresh lock (so no refresh of the row runs in between), and the
 * row takes the ChatGPT account the vault signs in as. Outside Claustrum mode
 * the row is enabled at once, with its own locks.
 */
async function enableUnderCustody(
  ctx: OpenCodeMenuContext,
  id: string,
  enable: (extraLocks?: readonly PoolLockSpec[]) => Promise<{ id: string }>,
): Promise<{ id: string }> {
  if ((await currentClaustrumMode(ctx)) !== 'claustrum') return enable()
  const check = ctx.checkUsableCustodyBinding
  const withLock =
    ctx.withFallbackAccountLock ??
    (async <T>(_id: string, action: () => Promise<T>) => action())
  // The row's fallback refresh lock is held around the whole check, so the
  // writes inside take only `main-refresh`.
  const locks = poolSettingsLocks(storePaths(ctx))
  return withLock(id, async () => {
    const store = ctx.store()
    const load = await store.read()
    const row =
      load.status === 'ready'
        ? load.rows.find((candidate) => candidate.id === id)
        : undefined
    if (!row || row.type !== 'oauth') return enable(locks)
    const binding = check
      ? await check({
          id,
          type: 'oauth',
          refresh: '',
          enabled: row.enabled,
          addedAt: row.addedAt ?? 0,
          lastUsed: 0,
          ...(row.identity !== undefined ? { accountId: row.identity } : {}),
        } as OAuthAccount)
      : { ready: false as const, reason: 'unbound-under-claustrum' }
    if (!binding.ready)
      throw new Error(
        `${id} remains disabled: ${binding.reason}. Resolve the custody binding, then try again.`,
      )
    if (row.identity !== binding.accountId)
      await store.recordIdentity(id, binding.accountId, { extraLocks: locks })
    return enable(locks)
  })
}

/** The `/openai` menu over this process's context. */
export function createOpenCodeMenu(ctx: OpenCodeMenuContext) {
  const paths = storePaths(ctx)
  const extraLocks = poolSettingsLocks(paths)
  const reset =
    ctx.resolveResetTarget &&
    ctx.refreshResetTargetQuota &&
    ctx.fetchImpl &&
    ctx.now &&
    ctx.randomUUID
      ? resetCreditsSection({
          configPath: paths.configPath,
          statePath: paths.statePath,
          quotaManager: ctx.quotaManager,
          loadAccounts: ctx.loadAccounts,
          mutateAccounts: settingsMutateAccounts(ctx.store(), extraLocks),
          resolveResetTarget: ctx.resolveResetTarget,
          refreshResetTargetQuota: ctx.refreshResetTargetQuota,
          fetchImpl: ctx.fetchImpl,
          now: ctx.now,
          randomUUID: ctx.randomUUID,
          accountKeys: () => resetAccountKeys(ctx),
        })
      : undefined
  const beginLogin = ctx.beginAccountLogin
  return createOpenAiMenu({
    store: ctx.store(),
    extraLocks,
    rowLocks: (id) => legacyRefreshLocks(paths, id),
    enableRow: (id, enable) => enableUnderCustody(ctx, id, enable),
    migration: ctx.migration,
    ...(beginLogin
      ? {
          login: {
            begin: (options) =>
              beginLogin({ ...options, version: ctx.packageVersion }),
            refusal: async () =>
              (await currentClaustrumMode(ctx)) === 'claustrum'
                ? 'Accounts cannot be added while Claustrum mode is active. Return to local mode first (Claustrum section).'
                : undefined,
            mainIdentity: async () => {
              const load = await ctx.store().read()
              if (load.status !== 'ready') return undefined
              return load.rows.find((row) => row.id === 'main')?.identity
            },
          },
        }
      : {}),
    protect: (id, view) => poolRemovalRefusal(id, view),
    ...(ctx.refreshAllQuota
      ? {
          quotaCheck: async () => {
            const results = (await ctx.refreshAllQuota?.()) ?? []
            const failures = results.filter((result) => !result.ok)
            if (failures.length > 0)
              throw new Error(
                failures
                  .map((failure) =>
                    failure.permanent
                      ? `${failure.account}: sign-in no longer accepted — remove and add this account again`
                      : `${failure.account}: fetch failed — check again to retry`,
                  )
                  .join('\n'),
              )
          },
        }
      : {}),
    cache: cacheSection(ctx),
    diagnostics: diagnosticsSection(ctx),
    extras: [
      ...(reset ? [reset] : []),
      sessionSection({
        ...(ctx.getStickyRouting ? { getPin: ctx.getStickyRouting } : {}),
        ...(ctx.clearStickyRouting ? { clearPin: ctx.clearStickyRouting } : {}),
      }),
      claustrumSection({
        mode: () => currentClaustrumMode(ctx),
        ...(ctx.enterClaustrumMode ? { enter: ctx.enterClaustrumMode } : {}),
        ...(ctx.leaveClaustrumMode ? { leave: ctx.leaveClaustrumMode } : {}),
      }),
    ],
    afterApply: async () => {
      await ctx.afterWrite?.()
      await ctx.refreshSidebar?.().catch(() => {})
    },
  })
}

/** Messages from work a menu action left running, delivered to the session's TUI. */
function sessionNotify(sessionId: string | undefined) {
  return (message: string, kind: 'info' | 'warning' | 'error' = 'info') => {
    log.info('menu notification', { sessionId, kind })
    pushNotification(
      { command: OPENAI_COMMAND_NAME, notify: { message, kind } },
      sessionId,
    )
  }
}

/** Opens the `/openai` menu for one session. */
export function openOpenAiMenu(
  ctx: OpenCodeMenuContext,
  sessionId: string | undefined,
): Promise<OpenDialogPayload> {
  return createOpenCodeMenu(ctx).open({
    ...(sessionId !== undefined ? { sessionId } : {}),
    notify: sessionNotify(sessionId),
  })
}

/** Applies one action the TUI's drawer sent back. */
export function applyOpenAiMenu(
  ctx: OpenCodeMenuContext,
  request: ApplyRequest,
): Promise<ApplyResult> {
  return createOpenCodeMenu(ctx).apply(request, {
    ...(request.sessionId !== undefined
      ? { sessionId: request.sessionId }
      : {}),
    notify: sessionNotify(request.sessionId),
  })
}

/** The menu as plain text, for a session with no TUI attached. */
export function menuText(menu: CommandMenuModel): string {
  const lines = [`## ${menu.title}`]
  for (const section of menu.sections) {
    lines.push('', `### ${section.title}`)
    for (const line of section.lines) lines.push(line)
    for (const item of section.items)
      lines.push(`- ${item.label}${item.detail ? `: ${item.detail}` : ''}`)
  }
  lines.push('', 'Open the OpenCode TUI to change these settings.')
  return lines.join('\n')
}
