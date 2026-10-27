// OpenCode 2's saved Codex thread ids, so a session keeps its prompt cache key
// (the thread id) across a server restart.
//
// One live map per session file per process. OpenCode 2 runs setup once per
// location and may load separate copies of this bundle, so the map is held in
// a process-wide registry keyed by the file's resolved path. The file is read
// only when that path's map is first created: a second location, or a
// location reload, shares the map and mints no new turn ids.
//
// Several OpenCode 2 server processes can share one file. Each save takes the
// file's lock, re-reads the file, and writes back what it read minus the
// sessions this process deleted, plus the sessions this process created.
// Sessions a process merely loaded are never written back, so a process that
// still holds a session another process deleted cannot bring it back. A save
// that would write back exactly what it read leaves the file in place, and
// saves wait a short delay so a burst of changes becomes one save.

import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { RefreshFileLock } from '@cortexkit/common-auth/fs'
import type { CodexSessionMetadata } from '../codex-request'
import {
  acquireCodexSessionsLock,
  CODEX_SESSIONS_LOCK_WAIT_MS,
  loadCodexSessions,
  readCodexSessionThreads,
  writeCodexSessionThreads,
} from '../codex-sessions'
import {
  getCodexSessionsPath,
  OPENCODE2_CODEX_SESSIONS_FILE,
} from '../core/account-paths'
import { uuidV7 } from '../util/uuid-v7'
import { FrameTurnState } from './frame-turn'

/** OpenCode 2's file, next to OpenCode 1's `openai-auth-sessions.json`. */
export { OPENCODE2_CODEX_SESSIONS_FILE }

/** In the runtime folder `core/account-paths.ts` resolves. */
export function opencode2CodexSessionsPath(): string {
  return getCodexSessionsPath('opencode2')
}

export interface CodexSessionStoreOptions {
  /** Mints the turn ids of loaded sessions; UUIDv7 by default. */
  uuid?: () => string
  /** Test seam: runs while the lock is held, after the file was re-read. */
  afterRead?: () => Promise<void>
  /** Test seam: the lock wait; `CODEX_SESSIONS_LOCK_WAIT_MS` by default. */
  lockWaitMs?: number
  /** Test seam: the save delay; `CODEX_SESSIONS_SAVE_DELAY_MS` by default. */
  saveDelayMs?: number
}

/**
 * How long a change waits before it is saved, so a burst of sessions starting
 * together (say, every open session resuming after a restart) costs one save
 * instead of one each. A save takes the file's lock and writes a temporary
 * file and renames it into place.
 *
 * A crash inside this window loses the thread ids of the sessions that
 * started in it. That only costs each of those sessions one cold prompt
 * cache: its next request after the restart starts a new thread. The saved
 * thread id never carries conversation state, so nothing else is lost. A
 * normal shutdown saves the pending changes at once (see `settled`).
 */
export const CODEX_SESSIONS_SAVE_DELAY_MS = 2_000

export class CodexSessionStore {
  readonly sessions: Map<string, CodexSessionMetadata>
  /**
   * Each session's WebSocket frame turn, kept next to its Codex metadata.
   * Every location in this process gets this same store, so they all share
   * one frame turn per session. It lives in memory only and is never written
   * to the session file at `path`.
   */
  readonly frameTurns = new FrameTurnState()
  /** Sessions this process created since its last successful save. */
  readonly #dirty = new Set<string>()
  /** Sessions this process deleted since its last successful save. */
  readonly #deleted = new Set<string>()
  /**
   * Deleted sessions this process never had in its map. The host reports
   * every deleted session, most of which never used OpenAI; the next save
   * checks the file and keeps only those it finds there, so deleting a
   * session the file never had writes nothing.
   */
  readonly #unconfirmed = new Set<string>()
  #saving: Promise<void> = Promise.resolve()
  #queued = false
  /** The one delayed save waiting to start, if any. */
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly path: string,
    readonly options: CodexSessionStoreOptions = {},
  ) {
    this.sessions = loadCodexSessions(path, options.uuid ?? uuidV7)
  }

  /** The session's metadata; a new session gets a new thread id and is saved. */
  get(sessionID: string, uuid: () => string = uuidV7): CodexSessionMetadata {
    let metadata = this.sessions.get(sessionID)
    if (!metadata) {
      const threadID = uuid()
      metadata = { threadID, turnID: uuid(), windowID: `${threadID}:0` }
      this.sessions.set(sessionID, metadata)
      // A session id reused after its deletion is a new session: the save
      // writes the new thread id, so the earlier deletion has nothing left
      // to remove.
      this.#deleted.delete(sessionID)
      this.#unconfirmed.delete(sessionID)
      this.#dirty.add(sessionID)
      this.#saveLater()
    }
    return metadata
  }

  /** Forgets a deleted host session here and, on the next save, in the file. */
  delete(sessionID: string): void {
    const known = this.sessions.delete(sessionID)
    this.frameTurns.forget(sessionID)
    this.#dirty.delete(sessionID)
    if (known) this.#deleted.add(sessionID)
    else if (!this.#deleted.has(sessionID)) this.#unconfirmed.add(sessionID)
    this.#saveLater()
  }

  /**
   * Starts a save after `CODEX_SESSIONS_SAVE_DELAY_MS` unless one is already
   * waiting; that one takes this change too. The timer does not keep the
   * process alive.
   */
  #saveLater(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      void this.save()
    }, this.options.saveDelayMs ?? CODEX_SESSIONS_SAVE_DELAY_MS)
    this.#timer.unref?.()
  }

  /**
   * Saves this process's changes now, taking over any delayed save. Saves run
   * one at a time; changes made while one runs go in the next. Never rejects:
   * a lock timeout or write failure keeps the changes for the next save.
   */
  save(): Promise<void> {
    clearTimeout(this.#timer)
    this.#timer = undefined
    if (!this.#queued) {
      this.#queued = true
      this.#saving = this.#saving.then(() => {
        this.#queued = false
        return this.#write()
      })
    }
    return this.#saving
  }

  /**
   * Starts a delayed save now, if one is waiting, and resolves once every
   * save has finished. The plugin's shutdown awaits this, so stopping never
   * drops changes still inside the save delay.
   */
  settled(): Promise<void> {
    return this.#timer ? this.save() : this.#saving
  }

  /**
   * Keeps the deletions of sessions this process never loaded only when the
   * file has them. The read takes no lock: the file is only ever replaced by
   * a rename, so it is never seen half written. A session another process
   * saves between this read and the next save is one created after the host
   * deleted its id, so it is a new session and is rightly kept.
   */
  #confirmDeletions(): void {
    if (this.#unconfirmed.size === 0) return
    let saved: Map<string, string>
    try {
      saved = readCodexSessionThreads(this.path)
    } catch {
      // No readable file has nothing to delete.
      saved = new Map()
    }
    for (const id of this.#unconfirmed)
      if (saved.has(id) && !this.sessions.has(id)) this.#deleted.add(id)
    this.#unconfirmed.clear()
  }

  async #write(): Promise<void> {
    this.#confirmDeletions()
    if (this.#dirty.size === 0 && this.#deleted.size === 0) return
    const created = [...this.#dirty].flatMap((id) => {
      const metadata = this.sessions.get(id)
      return metadata ? [[id, metadata] as const] : []
    })
    const deleted = [...this.#deleted]
    let lock: RefreshFileLock | null = null
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      lock = await this.#lock()
      if (!lock) return
      let threads: Map<string, string>
      try {
        threads = readCodexSessionThreads(this.path)
      } catch {
        threads = new Map()
      }
      await this.options.afterRead?.()
      let changed = false
      for (const id of deleted) if (threads.delete(id)) changed = true
      for (const [id, metadata] of created) {
        if (threads.get(id) === metadata.threadID) continue
        threads.set(id, metadata.threadID)
        changed = true
      }
      // The file already says what this process would write (another process
      // made the same deletion first, say): leave it in place.
      if (changed) writeCodexSessionThreads(this.path, threads)
    } catch {
      // Saved thread ids only keep the prompt cache warm across a restart;
      // a failed save never fails a request, and its changes stay pending.
      return
    } finally {
      await lock?.release().catch(() => {})
    }
    for (const [id, metadata] of created)
      if (this.sessions.get(id) === metadata) this.#dirty.delete(id)
    for (const id of deleted)
      if (!this.sessions.has(id)) this.#deleted.delete(id)
  }

  #lock(): Promise<RefreshFileLock | null> {
    return acquireCodexSessionsLock(
      this.path,
      this.options.lockWaitMs ?? CODEX_SESSIONS_LOCK_WAIT_MS,
    )
  }
}

const registryKey = Symbol.for(
  '@cortexkit/openai-auth/opencode2-codex-sessions',
)
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, CodexSessionStore>
}
const stores = processState[registryKey] ?? new Map<string, CodexSessionStore>()
processState[registryKey] = stores

/**
 * The process's one store for this session file, loading the file the first
 * time. Never released: the map lives until the server process exits, so a
 * location's reload keeps every session's thread and turn ids.
 */
export function acquireCodexSessions(
  path = opencode2CodexSessionsPath(),
): CodexSessionStore {
  const key = resolve(path)
  let store = stores.get(key)
  if (!store) {
    store = new CodexSessionStore(key)
    stores.set(key, store)
  }
  return store
}
