import type { OpenPoolStoreOptions } from '@cortexkit/common-auth/store'
import type { FailureTimeline } from './failure-timeline'

/** Drive detached quota publication after the polls, not by elapsed wall time. */
export function poolQuotaTimer(clock: FailureTimeline) {
  type Pending = { at: number; run: () => void | Promise<void> }
  const pending = new Set<Pending>()
  let scheduled = Promise.withResolvers<void>()
  let now = 0
  const timer: NonNullable<OpenPoolStoreOptions['quotaCommitTimer']> = {
    now: () => now,
    schedule: (ms, run) => {
      clock.phase(`quota commit scheduled: ${ms}ms`, () => {})
      const entry = { at: now + ms, run }
      pending.add(entry)
      scheduled.resolve()
      return {
        cancel: () => {
          pending.delete(entry)
        },
      }
    },
  }
  return {
    timer,
    next: () => (pending.size ? Promise.resolve() : scheduled.promise),
    async drain() {
      while (pending.size) {
        const next = [...pending].sort((a, b) => a.at - b.at)[0]
        if (!next) break
        pending.delete(next)
        now = next.at
        await clock.phase('quota commit timer fired', next.run)
      }
      scheduled = Promise.withResolvers<void>()
    },
  }
}
