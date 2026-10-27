// The on-disk record of each host session's Codex thread id. Both hosts keep
// it so a session's prompt cache key (the thread id) survives a server
// restart. Only thread ids are stored: a turn id is minted fresh on load, and
// no token or account is ever written here.
//
// OpenCode 1 and OpenCode 2 use separate files in the same runtime folder
// (`openai-auth-sessions.json` and `openai-auth-sessions-opencode2.json`), so
// neither host's writer can overwrite the other's sessions. Both writers hold
// the file's `sessions` lock while they write, which is also what the
// one-time move of the runtime files (`core/runtime-layout.ts`) takes.

import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import {
  acquireRefreshFileLock,
  type RefreshFileLock,
} from '@cortexkit/common-auth/fs'
import { isRecord } from '@cortexkit/openai-auth-core/internal'
import type { CodexSessionMetadata } from './codex-request'
import { uuidV7 } from './util/uuid-v7'

/** The lock every writer of a sessions file holds, named after that file. */
export const CODEX_SESSIONS_LOCK_NAME = 'sessions'
/**
 * Longer than any save holds the lock: OpenCode 2 re-reads the file, and
 * either host writes a small temporary file and renames it into place.
 */
export const CODEX_SESSIONS_LOCK_TTL_MS = 10_000
/** A save gives up after this long and leaves its changes for the next one. */
export const CODEX_SESSIONS_LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 25

/** The file's `sessions` lock, or null when it stayed held for `waitMs`. */
export async function acquireCodexSessionsLock(
  path: string,
  waitMs: number = CODEX_SESSIONS_LOCK_WAIT_MS,
): Promise<RefreshFileLock | null> {
  const deadline = performance.now() + waitMs
  for (;;) {
    const lock = await acquireRefreshFileLock({
      name: CODEX_SESSIONS_LOCK_NAME,
      path,
      ttlMs: CODEX_SESSIONS_LOCK_TTL_MS,
    })
    if (lock || performance.now() >= deadline) return lock
    await new Promise((done) => setTimeout(done, LOCK_RETRY_MS))
  }
}

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
 * and a rename so a reader never sees a partial write. The file is owner-only
 * (0600). The caller holds the file's `sessions` lock. Throws on failure.
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
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  // The mode above applies only when the file is created; a leftover from a
  // crashed save keeps its own.
  chmodSync(tmp, 0o600)
  renameSync(tmp, path)
}

// OpenCode 1's saves to one file run one at a time in this process.
const saving = new Map<string, Promise<void>>()

/**
 * Writes every session in the map under the file's `sessions` lock. Saves to
 * one file run one after another; a lock that stays held or a failed write is
 * ignored, and the next save writes the whole map again.
 */
export function saveCodexSessions(
  path: string,
  sessions: Map<string, CodexSessionMetadata>,
): Promise<void> {
  const previous = saving.get(path) ?? Promise.resolve()
  const next = previous.then(async () => {
    let lock: RefreshFileLock | null = null
    try {
      mkdirSync(dirname(path), { recursive: true })
      lock = await acquireCodexSessionsLock(path)
      if (!lock) return
      writeCodexSessionThreads(
        path,
        [...sessions.entries()].map(
          ([sessionID, state]) => [sessionID, state.threadID] as const,
        ),
      )
    } catch {
      // State persistence only improves cache continuity; never fail a request.
    } finally {
      await lock?.release().catch(() => {})
    }
  })
  saving.set(path, next)
  void next.then(() => {
    if (saving.get(path) === next) saving.delete(path)
  })
  return next
}
