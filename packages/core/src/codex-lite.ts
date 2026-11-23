import { moveInstructionsToDeveloperMessage } from './codex-instructions'
import { isRecord } from './util/record'

export const RESPONSES_LITE_HEADER = 'x-openai-internal-codex-responses-lite'

// Models whose Codex catalog entry supports the compact Responses Lite shape.
export const RESPONSES_LITE_MODELS: ReadonlySet<string> = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6.1-sol',
  'gpt-6.1-terra',
  'gpt-6.2-sol',
  'gpt-6.2-astra',
])

// Copy only changed paths: saved host history must retain image details for
// the next request's turn comparison, even when Lite strips them on the wire.
function stripResponsesLiteImageDetails(value: unknown): unknown {
  if (Array.isArray(value)) {
    let next = value
    for (let index = 0; index < value.length; index++) {
      const nested = stripResponsesLiteImageDetails(value[index])
      if (nested === value[index]) continue
      if (next === value) next = value.slice()
      next[index] = nested
    }
    return next
  }
  if (!isRecord(value)) return value
  let next = value
  for (const key of Object.keys(value)) {
    if (value.type === 'input_image' && key === 'detail') {
      if (next === value) next = { ...value }
      delete next[key]
      continue
    }
    const nested = stripResponsesLiteImageDetails(value[key])
    if (nested === value[key]) continue
    if (next === value) next = { ...value }
    next[key] = nested
  }
  return next
}

// Lite is opt-in because it disables parallel calls and excludes hosted tools.
export function rewriteResponsesLiteBody(parsed: Record<string, unknown>) {
  const reasoning = isRecord(parsed.reasoning) ? { ...parsed.reasoning } : {}
  reasoning.context = 'all_turns'
  parsed.reasoning = reasoning
  parsed.parallel_tool_calls = false
  const input = stripResponsesLiteImageDetails(
    Array.isArray(parsed.input) ? parsed.input : [],
  ) as unknown[]
  const tools = Array.isArray(parsed.tools)
    ? parsed.tools.filter(
        (tool) => !(isRecord(tool) && tool.type === 'web_search'),
      )
    : []
  parsed.input = [
    { type: 'additional_tools', role: 'developer', tools },
    ...input,
  ]
  moveInstructionsToDeveloperMessage(parsed, { responsesLite: true })
  delete parsed.tools
  delete parsed.instructions
}

/** Applies Lite for eligible HTTP model ids. The caller sets the Lite header. */
export function responsesLiteHttpBody(body: Record<string, unknown>): boolean {
  if (!supportsResponsesLite(body.model)) return false
  rewriteResponsesLiteBody(body)
  return true
}

export function supportsResponsesLite(model: unknown): boolean {
  return typeof model === 'string' && RESPONSES_LITE_MODELS.has(model)
}

export function resolveResponsesLite(
  configured?: boolean,
  override = process.env.CORTEXKIT_OPENAI_AUTH_RESPONSES_LITE,
): boolean {
  return parseBooleanOverride(override) ?? configured === true
}

export function parseBooleanOverride(
  raw: string | undefined,
): boolean | undefined {
  const value = raw?.trim().toLowerCase()
  if (value === undefined) return undefined
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  if (['', '0', 'false', 'no', 'off'].includes(value)) return false
  return undefined
}
