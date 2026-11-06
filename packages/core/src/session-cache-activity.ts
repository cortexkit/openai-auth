import {
  type AccountKey,
  createSessionActivityStore,
  type SessionActivityStore,
} from '@cortexkit/common-auth/limits'

export type {
  SessionActivity,
  SessionActivityStore,
} from '@cortexkit/common-auth/limits'
export { createSessionActivityStore }

/** Conservative policy lifetime, not an estimate of the provider's cache tail. */
export function is30MinCacheSupportedModel(bodyText: string): boolean {
  try {
    const model = (JSON.parse(bodyText) as { model?: unknown })?.model
    if (typeof model !== 'string') return false
    const match = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model)
    if (!match) return false
    const major = Number(match[1])
    const minor = Number(match[2] ?? 0)
    return major > 5 || (major === 5 && minor >= 6)
  } catch {
    return false
  }
}

export function ttlForModel(bodyText: string, defaultTtlMs = 300_000): number {
  return is30MinCacheSupportedModel(bodyText) ? 1_800_000 : defaultTtlMs
}

export interface SessionDispatch {
  readonly sessionId: string
  readonly accountKey: AccountKey
  readonly dispatchedAt: number
  readonly ttlMs: number
}

export type SessionCompletion =
  | { kind: 'http'; completed: boolean; failed: boolean; aborted: boolean }
  | { kind: 'ws'; event: string; aborted: boolean }
  | { kind: 'pi'; stop: 'stop' | 'error' | 'aborted'; aborted: boolean }
  | { kind: 'keep-warm'; status: number; aborted: boolean }
  | { kind: 'synthetic' }

/** Capture at dispatch; record clean completion only while the sent account is still current. */
export function recordSessionCompletion(
  activity: SessionActivityStore,
  dispatch: SessionDispatch,
  currentAccountKey: AccountKey | undefined,
  completion: SessionCompletion,
): boolean {
  if (!currentAccountKey || completion.kind === 'synthetic') return false
  if (completion.aborted) return false
  const accepted =
    completion.kind === 'http'
      ? completion.completed && !completion.failed
      : completion.kind === 'ws'
        ? completion.event === 'response.completed'
        : completion.kind === 'pi'
          ? completion.stop === 'stop'
          : completion.status >= 200 && completion.status < 300
  return (
    accepted &&
    activity.recordAccepted({
      sessionId: dispatch.sessionId,
      accountKey: dispatch.accountKey,
      currentAccountKey,
      lastAcceptedAt: dispatch.dispatchedAt,
      ttlMs: dispatch.ttlMs,
    })
  )
}
