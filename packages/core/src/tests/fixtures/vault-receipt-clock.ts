import { VAULT_RECEIPT_WAIT_MS } from '@cortexkit/common-auth/claustrum'

/**
 * Ends the vault's bounded wait for a receipt (the `VAULT_RECEIPT_WAIT_MS` timer
 * common-auth starts when the vault is unreachable and no token is saved) at once,
 * and moves `now` past it. Every other timer, such as sockets and retries, keeps
 * real time.
 */
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
