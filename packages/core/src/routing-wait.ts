import {
  type AccountKey,
  holdWaitMaxS,
  readMaxSameAccountWait,
  type SessionActivity,
} from '@cortexkit/common-auth/limits'
import type { AccountStorage } from './accounts'

export type { MaxSameAccountWait } from '@cortexkit/common-auth/limits'
export { holdWaitMaxS, readMaxSameAccountWait }

export function maxSameAccountWait(storage: AccountStorage | null) {
  return readMaxSameAccountWait(storage?.routing?.maxSameAccountWait)
}

export interface RoutingWaitInput {
  activity?: SessionActivity
  /** Current key, including login incarnation, of the activity account, not a new candidate. */
  accountKey?: AccountKey
  maxSameAccountWait?: unknown
}

export function routingHoldWaitMaxS(
  input: RoutingWaitInput & { sessionId: string; now: number },
): number | undefined {
  if (input.accountKey)
    return holdWaitMaxS({ ...input, accountKey: input.accountKey })
  // An accessor exposing accountFor gets zero even before the session has a cache.
  try {
    const accessor = Reflect.get(globalThis, Symbol.for('cortexkit.routing'))
    const handle =
      typeof accessor === 'function' ? accessor(input.sessionId) : undefined
    return typeof handle?.accountFor === 'function' ? 0 : undefined
  } catch {
    return undefined
  }
}
