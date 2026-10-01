// Pi's own `openai-codex` login, routed as row `main` beside the account
// pool's rows.
//
// Pi keeps this login in its own auth storage and refreshes it itself before
// every request it hands to this extension, so the extension never refreshes
// it, never stores it, and never writes Pi's auth storage: the token arrives
// with each request (`observeToken`) and is used as it is. What the extension
// keeps is the account's quota, in memory only, because the pool's store has
// no row for this account:
//
// - The first time a token of an account is seen (the session start, or the
//   first request) its quota is polled at once, so the account does not stay
//   blocked for want of a reading: unknown quota blocks, as on every row.
// - Quota observed on responses and WebSocket frames is merged in when the
//   token that produced it belongs to this account.
// - Quota is attributed by the account's ChatGPT identity (from the token's
//   JWT claims). A login of another account starts again from unknown quota,
//   so one account's reading never judges another.

import {
  isQuotaMap,
  mergeQuotaObservation,
  type QuotaMap,
  type QuotaObservation,
} from '@cortexkit/common-auth/quota'
import {
  extractAccountIdFromClaims,
  type OAuthQuotaSnapshot,
  parseJwtClaims,
} from '@cortexkit/openai-auth-core/internal'

import {
  observationFromSnapshot,
  windowsFromQuotaMap,
} from '@cortexkit/openai-auth-core/pool-quota'

/** Minimum interval between two quota polls of Pi's login asked for by admission. */
export const MAIN_PULL_RETRY_MS = 15_000

/** One quota poll of Pi's login: the full snapshot, for display, and its observation. */
export interface MainPoll {
  snapshot: OAuthQuotaSnapshot
  observation: QuotaObservation
}

export interface PiMainAccountDeps {
  /** Polls the quota of the account `token` belongs to. */
  poll: (token: string, identity: string | undefined) => Promise<MainPoll>
  now?: () => number
  pullRetryMs?: number
  log?: { warn(message: string, meta?: Record<string, unknown>): void }
}

/** The ChatGPT account a token belongs to, read from its JWT claims. */
export function identityOfToken(token: string | undefined): string | undefined {
  if (!token) return undefined
  const claims = parseJwtClaims(token)
  return claims ? extractAccountIdFromClaims(claims) : undefined
}

/** How one quota poll of Pi's login ended, for the `/openai` quota check. */
export interface MainPollResult {
  ok: boolean
  error?: string
}

export class PiMainAccount {
  private readonly deps: PiMainAccountDeps
  private readonly now: () => number
  private token: string | undefined
  private identity: string | undefined
  private quota: QuotaMap | undefined
  private snapshot: OAuthQuotaSnapshot | undefined
  /** The account (identity, else token) whose first poll has been started. */
  private firstPolledFor: string | undefined
  private inflight: Promise<MainPollResult> | undefined
  private lastPull: number | undefined

  constructor(deps: PiMainAccountDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  /**
   * Takes the token Pi holds for its login now. A token of another account
   * than the last one drops the last account's quota; an account seen for the
   * first time gets its quota polled at once. Never waits.
   */
  observeToken(token: string | undefined): void {
    if (!token) return
    const identity = identityOfToken(token)
    if (
      this.token !== undefined &&
      this.accountKey(this.token, this.identity) !==
        this.accountKey(token, identity)
    ) {
      this.quota = undefined
      this.snapshot = undefined
    }
    this.token = token
    this.identity = identity
    const key = this.accountKey(token, identity)
    if (this.firstPolledFor !== key) {
      this.firstPolledFor = key
      void this.pollNow()
    }
  }

  /** The token Pi last handed over, or undefined when none was seen yet. */
  currentToken(): string | undefined {
    return this.token
  }

  currentIdentity(): string | undefined {
    return this.identity
  }

  /** The quota map routing reads: undefined until a reading arrives. */
  quotaMap(): QuotaMap | undefined {
    return this.quota
  }

  /** The fixed windows of the quota map, plus the last poll's budget and reset credits. */
  quotaSnapshot(): OAuthQuotaSnapshot | undefined {
    const windows = windowsFromQuotaMap(this.quota)
    if (!windows && !this.snapshot) return undefined
    return {
      ...(this.snapshot?.resetCreditsAvailable !== undefined
        ? { resetCreditsAvailable: this.snapshot.resetCreditsAvailable }
        : {}),
      ...(this.snapshot?.spendControl
        ? { spendControl: this.snapshot.spendControl }
        : {}),
      ...windows,
    }
  }

  /**
   * Asks for a quota poll, at most once per `MAIN_PULL_RETRY_MS` unless
   * `force`. Admission calls this for every refusal for want of a reading, so
   * it never waits.
   */
  requestReading(force = false): void {
    const now = this.now()
    if (
      !force &&
      this.lastPull !== undefined &&
      now - this.lastPull < (this.deps.pullRetryMs ?? MAIN_PULL_RETRY_MS)
    )
      return
    void this.pollNow()
  }

  /** The poll under way, if any, so a caller may wait a bounded time for it. */
  pending(): Promise<MainPollResult> | undefined {
    return this.inflight
  }

  /** Polls now (joining a poll already under way) and reports how it ended. */
  pollNow(): Promise<MainPollResult> {
    if (this.inflight) return this.inflight
    const token = this.token
    if (!token)
      return Promise.resolve({ ok: false, error: 'Pi holds no OpenAI login' })
    const identity = this.identity
    this.lastPull = this.now()
    const run = (async (): Promise<MainPollResult> => {
      try {
        const result = await this.deps.poll(token, identity)
        // A poll that comes back after the login changed describes the
        // previous account and is dropped.
        if (
          this.accountKey(this.token, this.identity) !==
          this.accountKey(token, identity)
        )
          return { ok: true }
        this.snapshot = result.snapshot
        this.merge(result.observation)
        return { ok: true }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.deps.log?.warn('Pi login quota poll failed', { error: message })
        return { ok: false, error: message }
      }
    })()
    this.inflight = run
    void run.finally(() => {
      if (this.inflight === run) this.inflight = undefined
    })
    return run
  }

  /**
   * Records a quota snapshot that arrived with a response or a WebSocket
   * frame sent with `token`. Returns false, recording nothing, when the token
   * belongs to another account.
   */
  record(
    snapshot: Record<string, unknown>,
    token: string,
    complete: boolean,
  ): boolean {
    if (!this.owns(token)) return false
    const observation = observationFromSnapshot(snapshot, this.now(), complete)
    if (observation) this.merge(observation)
    return true
  }

  /** Whether `token` is this account's: its identity matches, or it is the current token. */
  owns(token: string): boolean {
    if (!this.token) return false
    const identity = identityOfToken(token)
    return identity && this.identity
      ? identity === this.identity
      : token === this.token
  }

  private merge(observation: QuotaObservation): void {
    try {
      const merged = mergeQuotaObservation(this.quota, observation)
      if (isQuotaMap(merged)) this.quota = merged
    } catch (error) {
      this.deps.log?.warn('Pi login quota observation not merged', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private accountKey(
    token: string | undefined,
    identity: string | undefined,
  ): string | undefined {
    if (identity) return `identity:${identity}`
    return token ? `token:${token}` : undefined
  }
}
