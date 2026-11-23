// Match Codex's serialization order to keep the prompt-cache prefix stable.
export const CODEX_BODY_KEY_ORDER = [
  'type',
  'model',
  'instructions',
  'previous_response_id',
  'input',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'reasoning',
  'store',
  'stream',
  'include',
  'prompt_cache_key',
  'text',
  'generate',
  'client_metadata',
]

// Reconstruct the body in Codex's exact key order; append any unexpected keys at the end.
// Order at the final send, after fields such as previous_response_id are added.
export function orderCodexBody(body: Record<string, unknown>) {
  const next: Record<string, unknown> = {}
  for (const key of CODEX_BODY_KEY_ORDER) if (key in body) next[key] = body[key]
  for (const key of Object.keys(body)) if (!(key in next)) next[key] = body[key]
  return next
}
