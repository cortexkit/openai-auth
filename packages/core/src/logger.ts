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
  flushLogs,
  type Level,
  setLogLevel,
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
 * floor. Use setLogLevel(undefined) to clear that runtime override and return
 * to the host's floor. The identity keys above are always added to redaction.
 */
export function initLogger(options: InitLoggerOptions): void {
  commonInitLogger({ ...options, extraSecretKeys: isOpenaiIdentityKey })
}

const LEVELS: readonly Level[] = ['error', 'warn', 'info', 'debug', 'trace']

export function parseLogLevel(value: string | undefined): Level | undefined {
  const level = value as Level | undefined
  return level && LEVELS.includes(level) ? level : undefined
}

/** A refresh back to defaults clears the override; an absent startup level does not. */
export function applySettingsLogLevel(
  level: Level | 'default',
  phase: 'startup' | 'refresh',
): void {
  if (level !== 'default') setLogLevel(level)
  else if (phase === 'refresh') setLogLevel(undefined)
}

let shutdownHookInstalled = false

/** Initialize a host's log destination and arrange for buffered writes to drain. */
export function setupLogger(options: InitLoggerOptions): void {
  initLogger(options)
  // Tests that assert on the log drain it explicitly.
  if (shutdownHookInstalled || process.env.NODE_ENV === 'test') return
  shutdownHookInstalled = true
  // Windows drains through async private-file IO, which cannot finish in `exit`.
  // Run once so closing the sink does not repeatedly re-arm `beforeExit`.
  process.once('beforeExit', async () => {
    try {
      await flushLogs()
    } catch {
      process.emitWarning(
        'OpenAI auth could not flush its log file at shutdown',
      )
    }
  })
  // POSIX flushing is synchronous, so explicit process.exit() can still drain it.
  if (process.platform !== 'win32') process.on('exit', () => flushLogs())
}
