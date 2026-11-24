import { Buffer } from 'node:buffer'
import { resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { DEFAULT_MAX_RECORDS } from '@cortexkit/common-auth/opencode2'
import {
  type AccountPaths,
  CACHE_KEEP_CAPS,
  createLogger,
  inputTransformationsOf,
  isRecord,
  shouldCaptureSessionCache,
} from '@cortexkit/openai-auth-core/internal'

const log = createLogger('cachekeep')

/** A completed conversation, ready for the HTTP replay adapter to capture. */
export interface FrameMirrorCapture {
  sessionID: string
  responseID: string
  bodyText: string
}

type Fields = Record<string, unknown>
type InvalidationReason =
  | 'output-incomplete'
  | 'provider-transformed'
  | 'fields-changed'
type Diagnostic = InvalidationReason | 'reasoning-reencrypted'
type DoneItem = { index?: number; item?: Fields }
type Head = {
  responseID: string
  responseIDBytes: number
  input: unknown[]
  inputBytes: number
}
type Pending = {
  input: unknown[]
  inputBytes: number
  output: DoneItem[]
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

function prefixFields(fields: Fields): Fields {
  // The HTTP warm forces streaming and store mode, drops generation caps, and
  // strips these two WS turn/timing stamps. Keep unknown metadata and all
  // other fields: reconstructing the input cannot account for their changes.
  const {
    stream: _stream,
    store: _store,
    max_output_tokens: _maxOutputTokens,
    max_tokens: _maxTokens,
    max_completion_tokens: _maxCompletionTokens,
    ...prefix
  } = fields
  if (isRecord(prefix.client_metadata)) {
    const {
      'x-codex-turn-metadata': _turn,
      'x-codex-ws-stream-request-start-ms': _start,
      ...metadata
    } = prefix.client_metadata
    prefix.client_metadata = metadata
  }
  return prefix
}

function indexedOutput(done: DoneItem[]): Fields[] | undefined {
  const output: Fields[] = []
  for (const { index, item } of done) {
    if (index === undefined || index >= done.length || output[index] || !item)
      return undefined
    output[index] = item
  }
  return output
}

function completedOutput(
  output: unknown,
  done: DoneItem[],
  onReencrypted: () => void,
): Fields[] | undefined {
  if (!Array.isArray(output) || !output.every(isRecord)) return undefined
  // OpenCode's continuation checkpoint prefers the emitted reasoning item
  // because completion can re-encrypt it (open-responses-continuation.ts,
  // v2.3.2 lines 201–208 and v2.4.1 lines 203–210). Take order, membership,
  // and all other items from the completion.
  const reasoning = new Map<string, Fields>()
  for (const { item } of done) {
    if (
      item?.type === 'reasoning' &&
      typeof item.id === 'string' &&
      !reasoning.has(item.id)
    )
      reasoning.set(item.id, item)
  }
  return output.map((item) => {
    if (item.type !== 'reasoning' || typeof item.id !== 'string') return item
    const emitted = reasoning.get(item.id)
    if (!emitted) return item
    if (!isDeepStrictEqual(emitted, item)) onReencrypted()
    return emitted
  })
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
  private readonly diagnostics = new Map<string, Set<Diagnostic>>()
  private bytes = 0

  constructor(private enabled = false) {}

  /**
   * Turning the user's keep-warm setting off forgets each session's snapshot,
   * except for sessions whose Thalamus cache plan still asks for warming
   * (`shouldCaptureSessionCache`).
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) {
      for (const sessionID of this.entries.keys()) {
        if (!shouldCaptureSessionCache(sessionID, enabled))
          this.dropSnapshot(sessionID)
      }
    }
  }

  /** Records the final response.create bytes, without changing the host frame. */
  send(sessionID: string, frame: string): void {
    if (!shouldCaptureSessionCache(sessionID, this.enabled)) {
      this.dropSnapshot(sessionID)
      return
    }
    const body = object(frame)
    if (body?.type !== 'response.create') return
    if (!Array.isArray(body.input)) {
      this.dropSnapshot(sessionID)
      return
    }
    const chained = 'previous_response_id' in body
    const previous = body.previous_response_id
    const prior = this.entries.get(sessionID)
    const head = prior?.head
    if (chained && (!head || previous !== head.responseID)) {
      // Retaining this delta would turn a partial prompt into a full replay.
      this.dropSnapshot(sessionID)
      return
    }
    const {
      type: _type,
      previous_response_id: _previous,
      input,
      ...fields
    } = body
    if (
      chained &&
      prior &&
      !isDeepStrictEqual(prefixFields(fields), prefixFields(prior.fields))
    ) {
      this.invalidate(sessionID, 'fields-changed')
      return
    }
    this.keep(sessionID, {
      fields: chained && prior ? prior.fields : fields,
      fieldsBytes: chained && prior ? prior.fieldsBytes : jsonBytes(fields),
      ...(chained && head ? { head } : {}),
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

  /** Completion consumes the pending send before notifying the warm tracker. */
  receive(
    sessionID: string,
    frame: string,
    track?: (capture: FrameMirrorCapture) => void,
  ): void {
    if (
      (!frame.includes('response.created') &&
        !frame.includes('response.output_item.done') &&
        !frame.includes('response.completed')) ||
      !shouldCaptureSessionCache(sessionID, this.enabled)
    )
      return
    const entry = this.entries.get(sessionID)
    if (!entry?.pending) return
    const event = object(frame)
    if (!event) return
    const pending = entry.pending
    const response = isRecord(event.response) ? event.response : undefined
    if (event.type === 'response.created' && typeof response?.id === 'string') {
      pending.responseID = response.id
      pending.responseIDBytes = jsonBytes(response.id)
      this.keep(sessionID, entry)
    } else if (event.type === 'response.output_item.done') {
      if (
        typeof event.response_id === 'string' &&
        pending.responseID !== undefined &&
        event.response_id !== pending.responseID
      )
        return
      const index = event.output_index
      const done: DoneItem = {
        index:
          typeof index === 'number' && Number.isSafeInteger(index) && index >= 0
            ? index
            : undefined,
        item: isRecord(event.item) ? event.item : undefined,
      }
      pending.output.push(done)
      pending.outputBytes += jsonBytes(done)
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
      if (inputTransformationsOf(response)) {
        this.invalidate(sessionID, 'provider-transformed')
        return
      }
      const output =
        'output' in response
          ? completedOutput(response.output, pending.output, () => {
              this.logOnce(sessionID, 'reasoning-reencrypted')
            })
          : indexedOutput(pending.output)
      if (!output) {
        this.invalidate(sessionID, 'output-incomplete')
        return
      }
      const head: Head = {
        responseID: response.id,
        responseIDBytes:
          pending.responseID === response.id
            ? pending.responseIDBytes
            : jsonBytes(response.id),
        input: [...(entry.head?.input ?? []), ...pending.input, ...output],
        inputBytes:
          (entry.head?.inputBytes ?? 0) +
          pending.inputBytes +
          inputBytes(output),
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
    this.dropSnapshot(sessionID)
    this.diagnostics.delete(sessionID)
  }

  private dropSnapshot(sessionID: string): void {
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

  private invalidate(sessionID: string, reason: InvalidationReason): void {
    this.dropSnapshot(sessionID)
    this.logOnce(sessionID, reason)
  }

  private logOnce(sessionID: string, reason: Diagnostic): void {
    const seen = this.diagnostics.get(sessionID) ?? new Set<Diagnostic>()
    this.diagnostics.delete(sessionID)
    this.diagnostics.set(sessionID, seen)
    // Retain only recent diagnostic keys, even if sessions are never deleted.
    if (this.diagnostics.size > DEFAULT_MAX_RECORDS) {
      const oldest = this.diagnostics.keys().next().value
      if (oldest !== undefined) this.diagnostics.delete(oldest)
    }
    if (seen.has(reason)) return
    seen.add(reason)
    if (reason === 'reasoning-reencrypted')
      log.debug('Codex reasoning differs between done and completed', {
        reason,
      })
    else log.info('OpenCode 2 keep-warm snapshot invalidated', { reason })
  }

  private keep(sessionID: string, entry: Entry): boolean {
    // Count both head and pending, including unfinished output. A single
    // session cannot retain more bytes than the entire store's byte budget.
    const bytes = entryBytes(entry)
    this.dropSnapshot(sessionID)
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
      this.dropSnapshot(oldest)
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
