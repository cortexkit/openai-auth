/**
 * Request-body dumps for cache debugging.
 *
 * Writing, redaction and the diff against the previous dump of the same
 * session and transport are the shared dumper from
 * `@cortexkit/common-auth/dump`. Each host supplies its settings; this module
 * supplies ChatGPT's redaction keys and the Responses body summary.
 */
import { createHash } from 'node:crypto'
import { createDumper, type Dumper } from '@cortexkit/common-auth/dump'
import { createLogger } from './logger'

const log = createLogger('dump')

export const DUMP_SESSION_HEADER = 'x-cortexkit-openai-auth-dump-session'
export const DEFAULT_DUMP_MAX_BYTES = 512 * 1024 * 1024

type DumpHeaders = ConstructorParameters<typeof Headers>[0]

type DumpTransport = 'http' | 'websocket'
type DumpPhase = 'http' | 'prewarm' | 'main' | 'observed'

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

/**
 * The shape of a Responses body (model, input and tool counts and hashes,
 * cache key) stored in each dump's metadata; `scripts/analyze-cache-cliffs.mjs`
 * reads it to explain prompt-cache misses between requests.
 */
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

export interface CodexDumpInput {
  sessionID?: string | null
  transport: DumpTransport
  phase: DumpPhase
  bodyText: string | (() => string)
  accountId?: string
  url?: string
  method?: string
  headers?: DumpHeaders
  status?: number
  error?: string
}

export function createCodexDumps(settings: {
  enabled: () => boolean
  dir: () => string
  maxBytes: () => number
}) {
  // Read settings on each dump so a changed setting needs no restart.
  let dumper: Dumper | undefined
  let dumperMaxBytes: number
  return {
    async dumpCodexRequest(input: CodexDumpInput): Promise<void> {
      if (!settings.enabled()) {
        dumper?.setEnabled(false)
        return
      }
      const maxBytes = settings.maxBytes()
      if (!dumper || maxBytes !== dumperMaxBytes) {
        dumper = createDumper({
          dir: settings.dir,
          maxBytes,
          logger: log,
          secretKeys: DUMP_SECRET_KEYS,
          schemaKeys: DUMP_SCHEMA_KEYS,
          summarize: bodySummary,
        })
        dumperMaxBytes = maxBytes
      }
      dumper.setEnabled(true)
      const bodyText =
        typeof input.bodyText === 'function' ? input.bodyText() : input.bodyText
      await dumper.dump({
        session: input.sessionID,
        channel: input.transport,
        phase: input.phase,
        bodyText,
        accountId: input.accountId,
        url: input.url,
        method: input.method,
        headers: input.headers,
        status: input.status,
        error: input.error,
      })
    },

    async dumpDiagnostic(event: Record<string, unknown>) {
      if (settings.enabled()) log.debug('diagnostic', event)
    },

    // Simulate a restart: the next dump must find its diff baseline on disk.
    resetDumpStateForTest() {
      dumper = undefined
    },
  }
}
