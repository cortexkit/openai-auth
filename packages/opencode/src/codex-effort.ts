import {
  isRecord,
  moveInstructionsToDeveloperMessage,
  applyMidConversationEffort as replayEffortUpdates,
} from '@cortexkit/openai-auth-core/internal'
import type { CodexSessionMetadata } from './codex-request'

// OpenCode's built-in definitions (packages/opencode/src/agent/agent.ts in the
// OpenCode repository) mark title, compaction and summary as hidden helpers,
// not the conversation's agent loop. chat.headers supplies the
// host's agent name; missing tags retain compatibility with other fetch callers.
const HIDDEN_EFFORT_AGENTS = new Set(['title', 'compaction', 'summary'])

export function applyMidConversationEffort(
  parsed: Record<string, unknown>,
  metadata: CodexSessionMetadata,
  agent: string | null,
) {
  if (agent !== null && HIDDEN_EFFORT_AGENTS.has(agent)) return
  replayEffortUpdates(parsed, metadata)
}

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
