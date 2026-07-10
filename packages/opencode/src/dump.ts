import { createHash } from 'node:crypto'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getSettings } from './config'
import { createLogger, redact } from './logger'

const log = createLogger('dump')

export const DUMP_SESSION_HEADER = 'x-cortexkit-openai-auth-dump-session'

type DumpHeaders = ConstructorParameters<typeof Headers>[0]

type DumpTransport = 'http' | 'websocket'
type DumpPhase = 'http' | 'prewarm' | 'main'

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

  const redacted = redact(parsed)
  const redactedText = JSON.stringify(redacted)
  if (redactedText === undefined) return bodyText
  return JSON.stringify(parsed) === redactedText ? bodyText : redactedText
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
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(nextDumpId).padStart(5, '0')}-${fileSegment(sessionID)}-${input.transport}-${input.phase}`
  const prefix = join(settings.dumpDir, id)
  const files = {
    body: `${prefix}.body.json`,
    metadata: `${prefix}.meta.json`,
    request: `${prefix}.request.json`,
  }
  const previousKey = `${input.transport}:${sessionID}`
  const previousBodyText = previousBodies.get(previousKey)

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
      status: input.status,
      error: input.error,
      bodyBytes: input.bodyText.length,
      bodyHash: hashText(input.bodyText),
      diff: diffSummary(previousBodyText, input.bodyText),
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
    rememberPreviousBody(previousKey, input.bodyText)
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
  nextDumpId = 0
  previousBodies.clear()
}
