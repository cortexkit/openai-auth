// The on-disk record of each host session's Codex thread id. Both hosts keep
// it so a session's prompt cache key (the thread id) survives a server
// restart. Only thread ids are stored: a turn id is minted fresh on load, and
// no token or account is ever written here.
//
// OpenCode 1 and OpenCode 2 use separate files in the same config directory
// (`openai-auth-sessions.json` and `openai-auth-sessions-opencode2.json`), so
// neither host's writer can overwrite the other's sessions.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { isRecord } from '@cortexkit/openai-auth-core/internal'
import type { CodexSessionMetadata } from './codex-request'
import { uuidV7 } from './util/uuid-v7'

interface PersistedCodexSessions {
  version?: number
  sessions?: Record<string, { threadID?: unknown }>
}

/**
 * Reads the thread id saved for each host session. Entries without a string
 * thread id are skipped. Throws when the file is missing or is not JSON.
 */
export function readCodexSessionThreads(path: string): Map<string, string> {
  const threads = new Map<string, string>()
  const parsed = JSON.parse(
    readFileSync(path, 'utf8'),
  ) as PersistedCodexSessions
  if (!isRecord(parsed.sessions)) return threads
  for (const [sessionID, state] of Object.entries(parsed.sessions)) {
    if (!isRecord(state) || typeof state.threadID !== 'string') continue
    threads.set(sessionID, state.threadID)
  }
  return threads
}

/**
 * Loads the saved sessions with a freshly minted turn id each. A missing or
 * malformed file loads as no sessions.
 */
export function loadCodexSessions(
  path: string,
  mint: () => string = uuidV7,
): Map<string, CodexSessionMetadata> {
  const sessions = new Map<string, CodexSessionMetadata>()
  let threads: Map<string, string>
  try {
    threads = readCodexSessionThreads(path)
  } catch {
    // Missing or malformed state should not break auth.
    return sessions
  }
  for (const [sessionID, threadID] of threads)
    sessions.set(sessionID, {
      threadID,
      turnID: mint(),
      windowID: `${threadID}:0`,
    })
  return sessions
}

/**
 * Replaces the file with exactly these thread ids, through a temporary file
 * and a rename so a reader never sees a partial write. Throws on failure.
 */
export function writeCodexSessionThreads(
  path: string,
  threads: Iterable<readonly [string, string]>,
): void {
  const tmp = `${path}.tmp-${process.pid}`
  mkdirSync(dirname(path), { recursive: true })
  const payload: PersistedCodexSessions = {
    version: 1,
    sessions: Object.fromEntries(
      [...threads].map(([sessionID, threadID]) => [sessionID, { threadID }]),
    ),
  }
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  renameSync(tmp, path)
}

/** Writes every session in the map; a failure is ignored. */
export function saveCodexSessions(
  path: string,
  sessions: Map<string, CodexSessionMetadata>,
): void {
  try {
    writeCodexSessionThreads(
      path,
      [...sessions.entries()].map(
        ([sessionID, state]) => [sessionID, state.threadID] as const,
      ),
    )
  } catch {
    // State persistence only improves cache continuity; never fail a request.
  }
}
