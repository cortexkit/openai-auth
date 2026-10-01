/**
 * Request-body dumps for cache debugging.
 *
 * Writing, redaction and the diff against the previous dump of the same
 * session and transport are the shared dumper from
 * `@cortexkit/common-auth/dump`. What stays here is OpenAI's part: the settings
 * that switch dumps on and choose the directory, the keys that identify a
 * ChatGPT user, and the summary of a Responses body stored in the metadata.
 */
import { createHash } from 'node:crypto'
import { createDumper, type Dumper } from '@cortexkit/common-auth/dump'
import { getSettings } from './config'
import { createLogger } from './logger'

const log = createLogger('dump')

export const DUMP_SESSION_HEADER = 'x-cortexkit-openai-auth-dump-session'

type DumpHeaders = ConstructorParameters<typeof Headers>[0]

type DumpTransport = 'http' | 'websocket'
type DumpPhase = 'http' | 'prewarm' | 'main'

/**
 * Keys redacted wherever they appear in a dump, on top of the shared
 * credential set: the same personal identifiers the log redactor hides. The
 * ChatGPT account id names a person's account; the internal `accountId`
 * ('main' or a fallback id) is deliberately not listed, because the dump
 * records which account served the request.
 */
export const DUMP_SECRET_KEYS = [
  'chatgpt-account-id',
  'email',
  'org_name',
  'organization_name',
] as const

/**
 * Tool definitions are declarations, not credentials: a parameter named
 * `api_key` says what the tool accepts, and redacting it by name would leave a
 * schema that no longer parses.
 */
export const DUMP_SCHEMA_KEYS = ['tools'] as const

function hashJson(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function toolType(tool: unknown) {
  return tool != null &&
    typeof tool === 'object' &&
    'type' in tool &&
    typeof tool.type === 'string'
    ? tool.type
    : 'unknown'
}

/** What `scripts/analyze-cache-cliffs.mjs` reads about a Responses body. */
export function bodySummary(parsed: Record<string, unknown>) {
  const input = Array.isArray(parsed.input) ? parsed.input : []
  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  const clientMetadata =
    parsed.client_metadata != null &&
    typeof parsed.client_metadata === 'object' &&
    !Array.isArray(parsed.client_metadata)
      ? (parsed.client_metadata as Record<string, unknown>)
      : undefined
  return {
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
    toolTypes: tools.map(toolType),
    toolsHash: hashJson(tools),
    clientMetadataKeys: clientMetadata
      ? Object.keys(clientMetadata).sort()
      : [],
  }
}

function newDumper(): Dumper {
  return createDumper({
    // Read on every dump, so a changed setting needs no restart.
    dir: () => getSettings().dumpDir,
    logger: log,
    secretKeys: DUMP_SECRET_KEYS,
    schemaKeys: DUMP_SCHEMA_KEYS,
    summarize: bodySummary,
  })
}

let dumper = newDumper()

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
}): Promise<void> {
  // The dump setting is read per request, so toggling it applies at once.
  dumper.setEnabled(getSettings().dump === true)
  await dumper.dump({
    session: input.sessionID,
    channel: input.transport,
    phase: input.phase,
    bodyText: input.bodyText,
    accountId: input.accountId,
    url: input.url,
    method: input.method,
    headers: input.headers,
    status: input.status,
    error: input.error,
  })
}

export async function dumpDiagnostic(event: Record<string, unknown>) {
  const settings = getSettings()
  if (!settings.dump) return
  log.debug('diagnostic', event)
}

/**
 * Stands in for a process restart: a new dumper with no in-memory diff
 * baselines, so the next dump of a session has to find its baseline on disk.
 * The file counter is shared by every dumper in the process, so the new one
 * cannot reuse a name the old one wrote.
 */
export function resetDumpStateForTest() {
  dumper = newDumper()
}
