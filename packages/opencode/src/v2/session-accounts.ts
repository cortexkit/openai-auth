// The account currently serving each OpenCode 2 session.
//
// `chooseAccount` records the account of every agent-loop (primary) request,
// in every routing mode. In the ordered modes a session's title, compaction
// and generate requests follow that account, and keep-warm must warm only
// that account. OpenCode 2 runs setup once per location, so the record is
// kept per server process and account store, not per location: every
// location's adapter reads and writes the same map, and a location's reload
// or disposal loses nothing.

import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import { accountStoreKey } from './shared-pins'

/** Most sessions whose current account is remembered. */
export const MAX_SESSION_ACCOUNTS = 1024

/** Read-only access to the account currently serving each session. */
export interface ActiveAccounts {
  /**
   * The account of the session's latest agent-loop request, or undefined
   * when none was recorded in this process or the session was evicted or
   * deleted since. Reading does not count as use for eviction.
   */
  activeAccount(sessionId: string): string | undefined
}

export class SessionAccounts implements ActiveAccounts {
  // Map order is the eviction order: the first key is the session whose
  // account was recorded longest ago.
  private readonly accounts = new Map<string, string>()
  private readonly limit: number

  constructor(limit = MAX_SESSION_ACCOUNTS) {
    this.limit = Math.max(1, limit)
  }

  /** Records the session's latest agent-loop account and marks it most recent. */
  record(sessionId: string, accountId: string): void {
    this.accounts.delete(sessionId)
    this.accounts.set(sessionId, accountId)
    while (this.accounts.size > this.limit) {
      const oldest = this.accounts.keys().next().value
      if (oldest === undefined) break
      this.accounts.delete(oldest)
    }
  }

  activeAccount(sessionId: string): string | undefined {
    return this.accounts.get(sessionId)
  }

  forget(sessionId: string): void {
    this.accounts.delete(sessionId)
  }

  get size(): number {
    return this.accounts.size
  }
}

const registryKey = Symbol.for(
  '@cortexkit/openai-auth/opencode2-session-accounts',
)
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, SessionAccounts>
}
const entries = processState[registryKey] ?? new Map<string, SessionAccounts>()
processState[registryKey] = entries

/**
 * The process's one session-account registry for this account store. Never
 * released: like the session pins, it lives until the server process exits,
 * so a location's reload still finds each session's account. Its size stays
 * bounded by MAX_SESSION_ACCOUNTS.
 */
export function acquireSessionAccounts(paths: AccountPaths): SessionAccounts {
  const key = accountStoreKey(paths)
  let accounts = entries.get(key)
  if (!accounts) {
    accounts = new SessionAccounts()
    entries.set(key, accounts)
  }
  return accounts
}
