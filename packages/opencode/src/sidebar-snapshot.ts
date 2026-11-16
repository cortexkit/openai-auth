import {
  type AccountStorage,
  type FallbackAccount,
  isOAuthAccount,
  killswitchPassesPolicy,
  type OAuthAccount,
  type OAuthQuotaSnapshot,
  type QuotaManager,
} from '@cortexkit/openai-auth-core/internal'
import type {
  AccountQuota,
  QuotaWindow,
  SidebarMachineState,
  SidebarState,
} from './sidebar-state'

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
  // Prepaid credits come only from a usage poll or the response headers that
  // carry them; a push without them keeps the last reading, with its own time.
  if (merged.credits === undefined && previous.credits !== undefined) {
    merged.credits = previous.credits
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
      killed: !killswitchPassesPolicy(mainQuota, store, undefined, now),
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
          killed: !killswitchPassesPolicy(
            fallbackQuota,
            store,
            account.id,
            now,
          ),
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

export function resolveSidebarSessionId(headers: Headers): string | undefined {
  return (
    headers.get('x-session-affinity') ??
    headers.get('x-opencode-session') ??
    headers.get('x-session-id') ??
    headers.get('session-id') ??
    undefined
  )
}
