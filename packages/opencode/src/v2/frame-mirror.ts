import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import type { AccountPaths } from '@cortexkit/openai-auth-core/internal'
import { CACHE_KEEP_CAPS } from '../core/cachekeep'

/** A completed conversation, ready for the HTTP replay adapter to capture. */
export interface FrameMirrorCapture {
  sessionID: string
  responseID: string
  bodyText: string
}

type Fields = Record<string, unknown>
type Head = { responseID: string; fields: Fields; input: unknown[] }
type Pending = {
  fields: Fields
  input: unknown[]
  output: unknown[]
  responseID?: string
}
type Entry = { head?: Head; pending?: Pending; bytes: number }

function object(text: string): Fields | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Fields
  } catch {}
  return undefined
}

/**
 * A bounded view of what the server holds on owned WebSocket sessions.
 * Map order is LRU order. A head includes its completed output; a pending
 * delta keeps only the new input and output, not another copy of the head.
 * Missing, evicted and broken baselines all recover only at a full frame.
 */
export class FrameMirror {
  readonly caps = CACHE_KEEP_CAPS
  private readonly entries = new Map<string, Entry>()
  private bytes = 0

  /** Records the final response.create bytes, without changing the host frame. */
  send(sessionID: string, frame: string): void {
    const body = object(frame)
    if (body?.type !== 'response.create') return
    if (!Array.isArray(body.input)) {
      this.forget(sessionID)
      return
    }
    const previous = body.previous_response_id
    const head = this.entries.get(sessionID)?.head
    if (previous && previous !== head?.responseID) {
      // Retaining this delta would turn a partial prompt into a full replay.
      this.forget(sessionID)
      return
    }
    const {
      type: _type,
      previous_response_id: _previous,
      input,
      ...fields
    } = body
    this.keep(sessionID, {
      ...(previous && head ? { head } : {}),
      pending: {
        fields: previous && head ? head.fields : fields,
        input: input as unknown[],
        output: [],
      },
      bytes: 0,
    })
  }

  /**
   * Output items are kept as received, including opaque encrypted reasoning.
   * Completion consumes the pending send before calling track, so duplicate
   * completed events cannot capture it twice. Without a subscriber this only
   * updates the mirror; it does not schedule or send a warm.
   */
  receive(
    sessionID: string,
    frame: string,
    track?: (capture: FrameMirrorCapture) => void,
  ): void {
    const entry = this.entries.get(sessionID)
    if (!entry?.pending) return
    const event = object(frame)
    if (!event) return
    const pending = entry.pending
    const response = event.response as Fields | undefined
    if (event.type === 'response.created' && typeof response?.id === 'string') {
      pending.responseID = response.id
      this.keep(sessionID, entry)
    } else if (event.type === 'response.output_item.done' && event.item) {
      if (
        typeof event.response_id === 'string' &&
        pending.responseID !== undefined &&
        event.response_id !== pending.responseID
      )
        return
      pending.output.push(event.item)
      this.keep(sessionID, entry)
    } else if (
      event.type === 'response.completed' &&
      typeof response?.id === 'string'
    ) {
      if (
        response.id === entry.head?.responseID ||
        (pending.responseID !== undefined && response.id !== pending.responseID)
      )
        return
      const head: Head = {
        responseID: response.id,
        fields: pending.fields,
        input: [
          ...(entry.head?.input ?? []),
          ...pending.input,
          ...pending.output,
        ],
      }
      if (!this.keep(sessionID, { head, bytes: 0 })) return
      track?.({
        sessionID,
        responseID: head.responseID,
        bodyText: this.body(head),
      })
    }
  }

  /** Builds only from a completed, available head, and marks that session used. */
  replay(sessionID: string): string | undefined {
    const entry = this.entries.get(sessionID)
    if (!entry?.head) return undefined
    this.entries.delete(sessionID)
    this.entries.set(sessionID, entry)
    return this.body(entry.head)
  }

  forget(sessionID: string): void {
    const entry = this.entries.get(sessionID)
    if (entry) this.bytes -= entry.bytes
    this.entries.delete(sessionID)
  }

  /** Size-only diagnostics; no retained message text escapes through status. */
  status() {
    return {
      bytes: this.bytes,
      sessions: [...this.entries].map(([sessionID, entry]) => ({
        sessionID,
        bytes: entry.bytes,
        responseID: entry.head?.responseID,
        pending: entry.pending !== undefined,
      })),
    }
  }

  private body(head: Head): string {
    return JSON.stringify({ ...head.fields, input: head.input, stream: true })
  }

  private keep(sessionID: string, entry: Entry): boolean {
    // Count both head and pending, including unfinished output. A single
    // session cannot retain more bytes than the entire store's byte budget.
    const bytes = Buffer.byteLength(
      JSON.stringify({ head: entry.head, pending: entry.pending }),
    )
    this.forget(sessionID)
    if (bytes > this.caps.maxBytes) return false
    entry.bytes = bytes
    this.entries.set(sessionID, entry)
    this.bytes += bytes
    while (
      this.entries.size > this.caps.maxTargets ||
      this.bytes > this.caps.maxBytes
    ) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.forget(oldest)
    }
    return this.entries.has(sessionID)
  }
}

const registryKey = Symbol.for('@cortexkit/openai-auth/opencode2-frame-mirror')
const processState = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, FrameMirror>
}
const entries = processState[registryKey] ?? new Map<string, FrameMirror>()
processState[registryKey] = entries

/** Shared across location reloads, independently bounded for each account store. */
export function acquireFrameMirror(paths: AccountPaths): FrameMirror {
  const key = JSON.stringify([
    resolve(paths.configPath),
    resolve(paths.statePath),
  ])
  let mirror = entries.get(key)
  if (!mirror) {
    mirror = new FrameMirror()
    entries.set(key, mirror)
  }
  return mirror
}
