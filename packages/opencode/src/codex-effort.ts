import { createHash } from 'node:crypto'
import {
  isRecord,
  moveInstructionsToDeveloperMessage,
} from '@cortexkit/openai-auth-core/internal'
import { type CodexSessionMetadata, isMessageWithRole } from './codex-request'
import { stableStringify } from './util/stable-json'

// Models where a `configuration_update` item is both accepted and shown to change
// effort. Accepted is not enough: a silently ignored item also completes with 200,
// so each entry was measured by reasoning tokens on one hard prompt at low effort,
// without and with an update to xhigh:
//   gpt-6-sol    91 -> 516
//   gpt-6-luna   1034 -> 3126
//   gpt-6.1-sol  878, 938 -> 1227, 1247 (two samples each; a request-level
//                xhigh on the same prompt gave 733 and 1456)
// gpt-5.6-sol is deliberately NOT here. It answered 400 for this item until
// September 2026, now accepts it, and moved 2292 -> 3785 on a single sample -
// too weak to tell from noise, on a model people already run, where the
// request-level effort change it uses today is known to work.
export const MID_CONVERSATION_EFFORT_MODELS: ReadonlySet<string> = new Set([
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6.1-sol',
])

// OpenCode's built-in definitions (packages/opencode/src/agent/agent.ts in the
// OpenCode repository) mark title, compaction and summary as hidden helpers,
// not the conversation's agent loop. chat.headers supplies the
// host's agent name; missing tags retain compatibility with other fetch callers.
const HIDDEN_EFFORT_AGENTS = new Set(['title', 'compaction', 'summary'])

/**
 * Keep the request-level effort fixed for prefix caching. The host does not
 * replay injected items, so remember each change at its original user message
 * and rebuild the same prefix before the WebSocket pool trims continuations.
 * Fingerprints detect compaction/revert at an anchor; a rewritten conversation
 * starts a new pin rather than replaying instructions into unrelated history.
 * Usage still reports the pinned request-level effort, not the effective one.
 */
export function applyMidConversationEffort(
  parsed: Record<string, unknown>,
  metadata: CodexSessionMetadata,
  agent: string | null,
) {
  if (agent !== null && HIDDEN_EFFORT_AGENTS.has(agent)) return
  const model = typeof parsed.model === 'string' ? parsed.model : ''
  if (!MID_CONVERSATION_EFFORT_MODELS.has(model)) return
  const reasoning = isRecord(parsed.reasoning) ? parsed.reasoning : undefined
  const effort =
    typeof reasoning?.effort === 'string' ? reasoning.effort : undefined
  if (!effort) return
  const input = Array.isArray(parsed.input) ? parsed.input : undefined
  metadata.effortUpdates ??= []
  const updates = metadata.effortUpdates
  const fingerprint = (item: unknown) =>
    createHash('sha256')
      .update(stableStringify(item))
      .digest('hex')
      .slice(0, 16)
  if (
    metadata.pinnedEffort === undefined ||
    updates.some(
      (update) =>
        !input ||
        !isMessageWithRole(input[update.anchor], 'user') ||
        fingerprint(input[update.anchor]) !== update.fingerprint,
    )
  ) {
    metadata.pinnedEffort = effort
    metadata.effortUpdates = []
    return
  }
  if (!input || input.length === 0) return
  const anchor = input.findLastIndex((item) => isMessageWithRole(item, 'user'))
  const latest = updates.at(-1)
  const effective = latest?.effort ?? metadata.pinnedEffort
  if (anchor >= 0 && effort !== effective) {
    if (latest?.anchor === anchor) {
      const before = updates.at(-2)?.effort ?? metadata.pinnedEffort
      if (effort === before) updates.pop()
      else latest.effort = effort
    } else {
      updates.push({ anchor, fingerprint: fingerprint(input[anchor]), effort })
    }
  } else if (anchor < 0 && effort !== effective) {
    // No user turn can carry a new instruction; leave the host's effort alone.
    return
  }
  // Anchors only ever grow, because a new one is the latest user message and
  // an older anchor that moved fails its fingerprint first. Should that ever
  // not hold, start over from this request's effort rather than fail the
  // request or send two updates side by side, which the API refuses.
  if (
    updates.some(
      (update, i) => i > 0 && update.anchor <= (updates[i - 1]?.anchor ?? -1),
    )
  ) {
    metadata.pinnedEffort = effort
    metadata.effortUpdates = []
    return
  }
  parsed.reasoning = { ...reasoning, effort: metadata.pinnedEffort }
  // Anchors are indices into the host's input. Inserting from the highest
  // anchor down keeps the lower ones valid. Each update goes in front of a
  // different user message, so that message always separates it from the
  // next update: the API refuses two updates side by side.
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i]
    if (!update) continue
    input.splice(update.anchor, 0, {
      type: 'configuration_update',
      reasoning: { effort: update.effort },
    })
  }
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
