/**
 * OpenCode's log destination.
 *
 * Core handles redaction and shutdown. OpenCode chooses the log file and
 * environment level floor.
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
  type Level,
  parseLogLevel,
  setupLogger,
} from '@cortexkit/openai-auth-core/tui-support'

export {
  applySettingsLogLevel,
  createLogger,
  flushForTest,
  flushLogs,
  type Level,
  redact,
  redactStrings,
  setLogLevel,
} from '@cortexkit/openai-auth-core/tui-support'

export function getLogFile(): string {
  return (
    process.env.OPENCODE_OPENAI_AUTH_LOG_FILE ??
    (process.platform === 'win32'
      ? join(tmpdir(), 'opencode-openai-auth', 'opencode-openai-auth.log')
      : join(tmpdir(), 'opencode-openai-auth.log'))
  )
}

export function getEnvLogLevel(): Level | undefined {
  return parseLogLevel(process.env.OPENCODE_OPENAI_AUTH_LOG_LEVEL)
}

setupLogger({ file: getLogFile, level: getEnvLogLevel })
