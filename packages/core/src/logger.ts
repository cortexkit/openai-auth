/**
 * The shared logger engine, with openai-auth's identity redaction added.
 *
 * Buffering, rotation, levels and the common credential redaction live in
 * `@cortexkit/common-auth/logger`. What stays here is the part only this plugin
 * knows: which extra keys carry personal data from ChatGPT and the vault. Every
 * host initialises through this module, so those keys are redacted in every log
 * line, and `redact`/`redactStrings` apply the same rules to the diagnostics a
 * host writes outside the log file (for example `dump`).
 */
import {
  type InitLoggerOptions as CommonInitLoggerOptions,
  initLogger as commonInitLogger,
  createRedactor,
} from '@cortexkit/common-auth/logger'

export {
  createLogger,
  flushForTest,
  flushLogs,
  type Level,
  resetLoggerForTest,
  setLogLevel,
} from '@cortexkit/common-auth/logger'

/**
 * Keys whose values are personal data rather than credentials, so the shared
 * set does not cover them. The key arrives lower-cased with `-` and `_` removed.
 *
 * Only the unambiguous ChatGPT stable id (chatgpt-account-id / chatgptAccountId)
 * is listed. A bare `accountId` field is overloaded: most diagnostic logs put
 * the internal account id ('main' or a fallback id) there, which is safe and
 * needed for debugging, so it is intentionally not redacted by name. The
 * operator identity on a served vault credential (email, organisation name) has
 * no diagnostic value and never reaches a log file.
 */
function isOpenaiIdentityKey(normalizedKey: string): boolean {
  return (
    normalizedKey === 'chatgptaccountid' ||
    normalizedKey === 'email' ||
    normalizedKey === 'orgname' ||
    normalizedKey === 'organizationname'
  )
}

const openaiRedactor = createRedactor({ extraSecretKeys: isOpenaiIdentityKey })

export const redact = openaiRedactor.redact
export const redactStrings = openaiRedactor.redactStrings

/** Where lines go and the level floor, as a host supplies them. */
export type InitLoggerOptions = Pick<CommonInitLoggerOptions, 'file' | 'level'>

/**
 * Point the logger at a host's file and level. Idempotent: calling it again
 * replaces both, and a runtime level from `setLogLevel` still outranks the
 * floor. The identity keys above are always added to the shared redaction.
 */
export function initLogger(options: InitLoggerOptions): void {
  commonInitLogger({ ...options, extraSecretKeys: isOpenaiIdentityKey })
}
