/**
 * OpenCode's log destination.
 *
 * The logger itself lives in the shared core so both hosts get the same
 * redaction rules. What stays here is the part that is specific to this host:
 * which file the lines go to, which level floor applies, and when the buffer is
 * drained at process exit. Those are the only three things that read this
 * host's environment variables, and the core reads none.
 *
 * The init runs at module load rather than from one call site because every
 * entry point in this package — the plugin loader, the RPC server, the separate
 * TUI process — reaches the logger through this module, and a core logger no
 * host has initialised silently drops every line. Both values are passed as
 * functions so the destination and level keep resolving on each write, which is
 * what they do today.
 */
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  flushLogs,
  initLogger,
  type Level,
} from '@cortexkit/openai-auth-core/internal'

export {
  createLogger,
  flushForTest,
  flushLogs,
  type Level,
  redact,
  redactStrings,
  setLogLevel,
} from '@cortexkit/openai-auth-core/internal'

const LEVELS: readonly Level[] = ['error', 'warn', 'info', 'debug', 'trace']

export function getLogFile(): string {
  return (
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE ??
    join(tmpdir(), 'opencode-openai-auth.log')
  )
}

export function getEnvLogLevel(): Level | undefined {
  const env = process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL as Level | undefined
  return env && LEVELS.includes(env) ? env : undefined
}

initLogger({ file: getLogFile, level: getEnvLogLevel })

// Under `bun test` the buffer is drained explicitly by the tests that assert on
// it, and registering a process-wide exit handler per test file is noise.
if (process.env.NODE_ENV !== 'test') process.on('exit', flushLogs)
