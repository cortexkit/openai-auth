import { VAULT_RECEIPT_WAIT_MS } from '@cortexkit/common-auth/claustrum'

/** Fast-forward the custody deadline while preserving real socket and retry scheduling. */
export function vaultReceiptClock() {
  let now = Date.now()
  let expire = false
  return {
    now: () => now,
    expireWaits: (enabled = true) => {
      expire = enabled
    },
    setTimeoutImpl: ((run: () => void, delay = 0) => {
      if (!expire || delay !== VAULT_RECEIPT_WAIT_MS)
        return setTimeout(run, delay)
      return setTimeout(() => {
        now += delay
        run()
      }, 0)
    }) as typeof setTimeout,
    clearTimeoutImpl: clearTimeout,
  }
}
