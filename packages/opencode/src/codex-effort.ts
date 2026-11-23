import {
  type CodexSessionMetadata,
  applyMidConversationEffort as replayEffortUpdates,
} from '@cortexkit/openai-auth-core/internal'

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
