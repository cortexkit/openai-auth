import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '@cortexkit/openai-auth-core/internal'
import { getSettings } from './config'
import { createLogger, redact, redactStrings } from './logger'

const log = createLogger('dump')

export const DUMP_SESSION_HEADER = 'x-cortexkit-openai-auth-dump-session'

type DumpHeaders = ConstructorParameters<typeof Headers>[0]

type DumpTransport = 'http' | 'websocket'
const DUMP_PHASES = ['http', 'prewarm', 'main'] as const
type DumpPhase = (typeof DUMP_PHASES)[number]

let nextDumpId = 0

const previousBodies = new Map<string, string>()
const PREVIOUS_BODY_LIMIT = 100

function shortSession(sessionID: string) {
  return sessionID.length <= 16 ? sessionID : `${sessionID.slice(0, 12)}…`
}

function fileSegment(value: string) {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized) return 'session-unknown'
  return normalized.length <= 80 ? normalized : normalized.slice(0, 80)
}

function hashText(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function hashJson(value: unknown) {
  return hashText(JSON.stringify(value))
}

function parseBody(bodyText: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(bodyText)
    return parsed != null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined
  } catch {
    return undefined
  }
}

function diffSummary(previousBodyText: string | undefined, bodyText: string) {
  if (previousBodyText === undefined) return null
  if (previousBodyText === bodyText) {
    return {
      changed: false,
      firstByte: -1,
      lastPreviousByte: -1,
      lastCurrentByte: -1,
      previousBytes: previousBodyText.length,
      currentBytes: bodyText.length,
    }
  }

  let firstByte = 0
  while (
    firstByte < previousBodyText.length &&
    firstByte < bodyText.length &&
    previousBodyText[firstByte] === bodyText[firstByte]
  ) {
    firstByte++
  }

  let previousTail = previousBodyText.length - 1
  let currentTail = bodyText.length - 1
  while (
    previousTail >= firstByte &&
    currentTail >= firstByte &&
    previousBodyText[previousTail] === bodyText[currentTail]
  ) {
    previousTail--
    currentTail--
  }

  return {
    changed: true,
    firstByte,
    lastPreviousByte: previousTail,
    lastCurrentByte: currentTail,
    changedPreviousBytes: previousTail - firstByte + 1,
    changedCurrentBytes: currentTail - firstByte + 1,
    previousBytes: previousBodyText.length,
    currentBytes: bodyText.length,
  }
}

function rememberPreviousBody(key: string, bodyText: string) {
  if (!previousBodies.has(key)) {
    while (previousBodies.size >= PREVIOUS_BODY_LIMIT) {
      const oldest = previousBodies.keys().next().value
      if (oldest === undefined) break
      previousBodies.delete(oldest)
    }
  }
  previousBodies.set(key, bodyText)
}

/**
 * Keys whose disk baseline has already been looked up this process.
 *
 * Separate from `previousBodies` so a key with no prior dump on disk is not
 * re-scanned on every request — a miss must be remembered as firmly as a hit.
 */
const diskBaselineChecked = new Set<string>()

/**
 * Recover a diff baseline from the dump directory on the first dump of a key.
 *
 * `previousBodies` dies with the process, so without this the first request
 * after a restart reports no diff at all. That is the request the diff matters
 * most for: a restart is exactly when the prompt cache is most likely to break,
 * and "no baseline" is indistinguishable from "nothing changed" in the metadata.
 *
 * The baseline is read back from the dumps themselves rather than persisted
 * separately. The previous body is already on disk as a `.body.json`, so
 * recovering it needs no new state, and clearing the dump directory correctly
 * clears the baseline with it — a baseline that outlived its dump would diff
 * against a body the operator can no longer open.
 *
 * Best-effort by construction: any failure yields no baseline, which is exactly
 * today's behaviour.
 */
async function recoverBaselineFromDisk(
  dumpDir: string,
  sessionID: string,
  transport: DumpTransport,
): Promise<string | undefined> {
  const segment = fileSegment(sessionID)
  // Match the full filename tail rather than a substring: a session id that
  // itself ends in the transport name would otherwise collide with a different
  // session's dumps.
  const suffixes = DUMP_PHASES.map(
    (phase) => `-${segment}-${transport}-${phase}.body.json`,
  )
  try {
    const entries = await readdir(dumpDir)
    // Filenames are ISO-timestamp-then-counter prefixed, so lexicographic order
    // is chronological.
    const newest = entries
      .filter((name) => suffixes.some((suffix) => name.endsWith(suffix)))
      .sort()
      .pop()
    if (!newest) return undefined
    return await readFile(join(dumpDir, newest), 'utf8')
  } catch {
    return undefined
  }
}

function headersToRecord(headers: DumpHeaders | undefined) {
  if (headers === undefined) return undefined
  return Object.fromEntries(new Headers(headers).entries())
}

function redactForDump(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactForDump)
  if (value == null || typeof value !== 'object') return value

  const redacted: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    const lower = key.toLowerCase()
    if (
      lower === 'authorization' ||
      lower === 'chatgpt-account-id' ||
      lower === 'cookie' ||
      lower === 'set-cookie'
    ) {
      redacted[key] = '[redacted]'
      continue
    }
    redacted[key] = redactForDump(entry)
  }
  return redacted
}

function redactBodyForDump(bodyText: string) {
  const parsed = parseBody(bodyText)
  if (parsed === undefined) return bodyText

  const redacted = redactBodyValue(parsed)
  const redactedText = JSON.stringify(redacted)
  if (redactedText === undefined) return bodyText
  return JSON.stringify(parsed) === redactedText ? bodyText : redactedText
}

/**
 * Tool definitions are declarations, not credentials: a parameter named
 * `api_key` says what the tool accepts, and redacting that node by name leaves
 * a schema that no longer parses — which also makes the dump unusable as a
 * replayable capture. Strings inside them are still scrubbed, so a credential
 * written into a description does not survive. Key order is preserved because
 * the cache analyzer diffs these bodies against each other.
 */
function redactBodyValue(parsed: unknown): unknown {
  if (!isRecord(parsed)) return redact(parsed)
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    out[key] =
      key === 'tools'
        ? redactStrings(value)
        : (redact({ [key]: value }) as Record<string, unknown>)[key]
  }
  return out
}

function toolType(tool: unknown) {
  return tool != null &&
    typeof tool === 'object' &&
    'type' in tool &&
    typeof tool.type === 'string'
    ? tool.type
    : 'unknown'
}

function bodySummary(bodyText: string) {
  const parsed = parseBody(bodyText)
  if (!parsed) return { parseable: false as const }

  const input = Array.isArray(parsed.input) ? parsed.input : []
  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  const toolTypes = tools.map(toolType)
  const clientMetadata =
    parsed.client_metadata != null &&
    typeof parsed.client_metadata === 'object' &&
    !Array.isArray(parsed.client_metadata)
      ? (parsed.client_metadata as Record<string, unknown>)
      : undefined
  return {
    parseable: true as const,
    model: typeof parsed.model === 'string' ? parsed.model : undefined,
    stream: parsed.stream,
    generate: parsed.generate,
    store: parsed.store,
    previousResponseID:
      typeof parsed.previous_response_id === 'string'
        ? parsed.previous_response_id
        : undefined,
    promptCacheKey:
      typeof parsed.prompt_cache_key === 'string'
        ? parsed.prompt_cache_key
        : undefined,
    reasoning: parsed.reasoning,
    inputCount: input.length,
    inputHash: hashJson(input),
    inputBytes: JSON.stringify(input).length,
    firstInputHash: input[0] === undefined ? null : hashJson(input[0]),
    toolsCount: tools.length,
    toolTypes,
    toolsHash: hashJson(tools),
    hasWebSearch: toolTypes.includes('web_search'),
    clientMetadataKeys: clientMetadata
      ? Object.keys(clientMetadata).sort()
      : [],
  }
}

export async function dumpCodexRequest(input: {
  sessionID?: string | null
  transport: DumpTransport
  phase: DumpPhase
  bodyText: string
  accountId?: string
  url?: string
  method?: string
  headers?: DumpHeaders
  status?: number
  error?: string
}) {
  const settings = getSettings()
  if (!settings.dump) return

  nextDumpId++
  const sessionID = input.sessionID?.trim() || 'session-unknown'
  // The pid is part of the name because the counter alone does not make it
  // unique. Every process starts the counter at zero, and the default dump
  // directory is a fixed path, so two processes dumping the same session in the
  // same millisecond would otherwise write the same filename and one would
  // silently overwrite the other — a lost artifact in the tool used to explain
  // lost cache hits. A restart is the same collision with one process.
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}-${String(nextDumpId).padStart(5, '0')}-${fileSegment(sessionID)}-${input.transport}-${input.phase}`
  const prefix = join(settings.dumpDir, id)
  const files = {
    body: `${prefix}.body.json`,
    metadata: `${prefix}.meta.json`,
    request: `${prefix}.request.json`,
  }
  const previousKey = `${input.transport}:${sessionID}`
  let previousBodyText = previousBodies.get(previousKey)
  let baselineSource: 'memory' | 'disk' | undefined = previousBodyText
    ? 'memory'
    : undefined
  if (previousBodyText === undefined && !diskBaselineChecked.has(previousKey)) {
    diskBaselineChecked.add(previousKey)
    previousBodyText = await recoverBaselineFromDisk(
      settings.dumpDir,
      sessionID,
      input.transport,
    )
    if (previousBodyText !== undefined) baselineSource = 'disk'
  }

  try {
    await mkdir(settings.dumpDir, { recursive: true, mode: 0o700 })
    await chmod(settings.dumpDir, 0o700).catch(() => {})
    const bodyForDump = redactBodyForDump(input.bodyText)
    const metadata = {
      id,
      createdAt: new Date().toISOString(),
      session: shortSession(sessionID),
      transport: input.transport,
      phase: input.phase,
      accountId: input.accountId,
      status: input.status,
      error: input.error,
      bodyBytes: input.bodyText.length,
      bodyHash: hashText(input.bodyText),
      // Diffed on the redacted text, which is what lands in the `.body.json`
      // beside this metadata. Byte offsets therefore index the file an operator
      // can actually open, and a disk-recovered baseline (also redacted)
      // compares like with like instead of reporting redaction as a change.
      diff: diffSummary(previousBodyText, bodyForDump),
      baselineSource,
      body: bodySummary(input.bodyText),
      files,
    }
    await Promise.all([
      writeFile(files.body, bodyForDump, { encoding: 'utf8', mode: 0o600 }),
      writeFile(files.metadata, `${JSON.stringify(metadata, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      }),
      writeFile(
        files.request,
        `${JSON.stringify(
          redactForDump({
            url: input.url,
            method: input.method,
            accountId: input.accountId,
            headers: headersToRecord(input.headers),
          }),
          null,
          2,
        )}\n`,
        { encoding: 'utf8', mode: 0o600 },
      ),
    ])
    log.debug('dumped request', {
      id,
      session: shortSession(sessionID),
      body: files.body,
      meta: files.metadata,
    })
    rememberPreviousBody(previousKey, bodyForDump)
  } catch (error) {
    // Dumping is diagnostic-only. Never write failures to stderr: OpenCode surfaces plugin stderr
    // directly in the TUI, which would make an optional debug feature noisy for users.
    log.warn('request dump failed', {
      session: shortSession(sessionID),
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function dumpDiagnostic(event: Record<string, unknown>) {
  const settings = getSettings()
  if (!settings.dump) return
  log.debug('diagnostic', event)
}

export function resetDumpStateForTest() {
  // Deliberately does NOT rewind nextDumpId. This stands in for a fresh
  // process, and a real one differs from its predecessor by pid, which is in
  // the filename. Rewinding the counter instead makes two dumps collide on a
  // filename whenever they land in the same millisecond — a collision a real
  // restart cannot produce, which would silently overwrite the very artifact a
  // restart test is inspecting.
  previousBodies.clear()
  // A fresh process has not yet looked on disk for any key, so leaving this
  // populated would suppress the cold-start recovery a restart should trigger.
  diskBaselineChecked.clear()
}
