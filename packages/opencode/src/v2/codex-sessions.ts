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
// still holds a session another process deleted cannot bring it back.

import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  acquireRefreshFileLock,
  type RefreshFileLock,
} from '@cortexkit/common-auth/fs'
import type { CodexSessionMetadata } from '../codex-request'
import {
  loadCodexSessions,
  readCodexSessionThreads,
  writeCodexSessionThreads,
} from '../codex-sessions'
import { getConfigDir } from '../config'
import { uuidV7 } from '../util/uuid-v7'
import { FrameTurnState } from './frame-turn'

/** OpenCode 2's file, next to OpenCode 1's `openai-auth-sessions.json`. */
export const OPENCODE2_CODEX_SESSIONS_FILE =
  'openai-auth-sessions-opencode2.json'

export function opencode2CodexSessionsPath(): string {
  return join(getConfigDir(), OPENCODE2_CODEX_SESSIONS_FILE)
}

const LOCK_NAME = 'sessions'
/** Longer than any save holds the lock: a re-read and one small rename. */
const LOCK_TTL_MS = 10_000
/** A save gives up after this long and leaves its changes for the next one. */
const LOCK_WAIT_MS = 5_000
const LOCK_RETRY_MS = 25

export interface CodexSessionStoreOptions {
  /** Mints the turn ids of loaded sessions; UUIDv7 by default. */
  uuid?: () => string
  /** Test seam: runs while the lock is held, after the file was re-read. */
  afterRead?: () => Promise<void>
  /** Test seam: the lock wait; `LOCK_WAIT_MS` by default. */
  lockWaitMs?: number
}

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
  #saving: Promise<void> = Promise.resolve()
  #queued = false

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
      this.#dirty.add(sessionID)
      void this.save()
    }
    return metadata
  }

  /** Forgets a deleted host session here and, on the next save, in the file. */
  delete(sessionID: string): void {
    this.sessions.delete(sessionID)
    this.frameTurns.forget(sessionID)
    this.#dirty.delete(sessionID)
    this.#deleted.add(sessionID)
    void this.save()
  }

  /**
   * Saves this process's changes. Saves run one at a time; changes made while
   * one runs go in the next. Never rejects: a lock timeout or write failure
   * keeps the changes for the next save.
   */
  save(): Promise<void> {
    if (!this.#queued) {
      this.#queued = true
      this.#saving = this.#saving.then(() => {
        this.#queued = false
        return this.#write()
      })
    }
    return this.#saving
  }

  /** Resolves once every save started so far has finished. */
  settled(): Promise<void> {
    return this.#saving
  }

  async #write(): Promise<void> {
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
      for (const id of deleted) threads.delete(id)
      for (const [id, metadata] of created) threads.set(id, metadata.threadID)
      writeCodexSessionThreads(this.path, threads)
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

  async #lock(): Promise<RefreshFileLock | null> {
    const deadline =
      performance.now() + (this.options.lockWaitMs ?? LOCK_WAIT_MS)
    for (;;) {
      const lock = await acquireRefreshFileLock({
        name: LOCK_NAME,
        path: this.path,
        ttlMs: LOCK_TTL_MS,
      })
      if (lock || performance.now() >= deadline) return lock
      await new Promise((done) => setTimeout(done, LOCK_RETRY_MS))
    }
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
