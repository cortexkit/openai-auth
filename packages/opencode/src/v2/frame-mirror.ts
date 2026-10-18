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
type Head = {
  responseID: string
  responseIDBytes: number
  input: unknown[]
  inputBytes: number
}
type Pending = {
  input: unknown[]
  inputBytes: number
  output: unknown[]
  outputBytes: number
  responseID?: string
  responseIDBytes: number
}
type Entry = {
  fields: Fields
  fieldsBytes: number
  head?: Head
  pending?: Pending
  bytes: number
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value))
}

/** Item sums exclude array punctuation, which is derived from the item count. */
function inputBytes(items: unknown[]): number {
  return items.reduce<number>((bytes, item) => bytes + jsonBytes(item), 0)
}

function arrayBytes(bytes: number, count: number): number {
  return 2 + bytes + Math.max(0, count - 1)
}

/** Exact JSON size of the retained payload, excluding cached byte counters. */
function entryBytes(entry: Entry): number {
  const head = entry.head
  const pending = entry.pending
  return (
    '{"fields":'.length +
    entry.fieldsBytes +
    '}'.length +
    (head
      ? ',"head":{"responseID":'.length +
        head.responseIDBytes +
        ',"input":'.length +
        arrayBytes(head.inputBytes, head.input.length) +
        '}'.length
      : 0) +
    (pending
      ? ',"pending":{"input":'.length +
        arrayBytes(pending.inputBytes, pending.input.length) +
        ',"output":'.length +
        arrayBytes(pending.outputBytes, pending.output.length) +
        (pending.responseID === undefined
          ? 0
          : ',"responseID":'.length + pending.responseIDBytes) +
        '}'.length
      : 0)
  )
}

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

  constructor(private enabled = false) {}

  /** Disabling discards every baseline; re-enabling waits for a new full frame. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      this.entries.clear()
      this.bytes = 0
    }
  }

  /** Records the final response.create bytes, without changing the host frame. */
  send(sessionID: string, frame: string): void {
    if (!this.enabled) return
    const body = object(frame)
    if (body?.type !== 'response.create') return
    if (!Array.isArray(body.input)) {
      this.forget(sessionID)
      return
    }
    const previous = body.previous_response_id
    const prior = this.entries.get(sessionID)
    const head = prior?.head
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
      fields: previous && prior ? prior.fields : fields,
      fieldsBytes: previous && prior ? prior.fieldsBytes : jsonBytes(fields),
      ...(previous && head ? { head } : {}),
      pending: {
        input: input as unknown[],
        inputBytes: inputBytes(input as unknown[]),
        output: [],
        outputBytes: 0,
        responseIDBytes: 0,
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
    if (
      !this.enabled ||
      (!frame.includes('response.created') &&
        !frame.includes('response.output_item.done') &&
        !frame.includes('response.completed'))
    )
      return
    const entry = this.entries.get(sessionID)
    if (!entry?.pending) return
    const event = object(frame)
    if (!event) return
    const pending = entry.pending
    const response = event.response as Fields | undefined
    if (event.type === 'response.created' && typeof response?.id === 'string') {
      pending.responseID = response.id
      pending.responseIDBytes = jsonBytes(response.id)
      this.keep(sessionID, entry)
    } else if (event.type === 'response.output_item.done' && event.item) {
      if (
        typeof event.response_id === 'string' &&
        pending.responseID !== undefined &&
        event.response_id !== pending.responseID
      )
        return
      pending.output.push(event.item)
      pending.outputBytes += jsonBytes(event.item)
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
        responseIDBytes:
          pending.responseID === response.id
            ? pending.responseIDBytes
            : jsonBytes(response.id),
        input: [
          ...(entry.head?.input ?? []),
          ...pending.input,
          ...pending.output,
        ],
        inputBytes:
          (entry.head?.inputBytes ?? 0) +
          pending.inputBytes +
          pending.outputBytes,
      }
      const completed = { ...entry, head, pending: undefined }
      if (!this.keep(sessionID, completed)) return
      track?.({
        sessionID,
        responseID: head.responseID,
        bodyText: this.body(entry.fields, head),
      })
    }
  }

  /** Builds only from a completed, available head, and marks that session used. */
  replay(sessionID: string): string | undefined {
    const entry = this.entries.get(sessionID)
    if (!entry?.head) return undefined
    this.entries.delete(sessionID)
    this.entries.set(sessionID, entry)
    return this.body(entry.fields, entry.head)
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

  private body(fields: Fields, head: Head): string {
    return JSON.stringify({ ...fields, input: head.input, stream: true })
  }

  private keep(sessionID: string, entry: Entry): boolean {
    // Count both head and pending, including unfinished output. A single
    // session cannot retain more bytes than the entire store's byte budget.
    const bytes = entryBytes(entry)
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
