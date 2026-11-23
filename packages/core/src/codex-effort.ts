import { createHash } from 'node:crypto'
import { gptModelVersion } from './codex-models'
import { isRecord } from './util/record'
import { stableStringify } from './util/stable-json'

// OpenAI's reasoning guide ("Change reasoning mid-conversation") documents
// configuration_update for supported GPT-6 and later models:
// https://developers.openai.com/api/docs/guides/reasoning
// Changing request-level effort missed the cache on 4 of 4 tested models;
// sending the item with request-level effort pinned kept it on all four.
// Reasoning tokens at low effort, without and with an update to xhigh:
//   gpt-6-sol      91 -> 516
//   gpt-6-luna     1034 -> 3126
//   gpt-6.1-sol    878/938 -> 1227/1247 (request-level xhigh: 733/1456)
//   gpt-6.2-sol    215/175 -> 3607/1693
//   gpt-6.2-astra  358/415 -> 1372/1886
// gpt-5.6-sol is outside the documented scope. It now accepts the item, but
// the change (2292 -> 3785 in one sample) was too weak to distinguish from
// noise. Its request-level effort change is known to work.
export function supportsMidConversationEffort(model: string): boolean {
  const version = gptModelVersion(model)
  return version !== undefined && Number(version.split('.')[0]) >= 6
}

export interface CodexEffortState {
  pinnedEffort?: string
  effortUpdates?: Array<{ anchor: number; fingerprint: string; effort: string }>
}

export function isMessageWithRole(item: unknown, role: string) {
  return (
    isRecord(item) &&
    (item.type === 'message' || 'role' in item) &&
    item.role === role
  )
}

/**
 * Keep request-level effort fixed for prefix caching. The host does not replay
 * injected items, so rebuild each change at its original user message before
 * the transport trims WebSocket continuations. If compaction or revert rewrites
 * an anchor, start a new pin instead of replaying unrelated updates.
 * Usage still reports the pinned request-level effort, not the effective one.
 */
export function applyMidConversationEffort(
  body: Record<string, unknown>,
  state: CodexEffortState,
) {
  const model = typeof body.model === 'string' ? body.model : ''
  if (!supportsMidConversationEffort(model)) return
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined
  const effort =
    typeof reasoning?.effort === 'string' ? reasoning.effort : undefined
  if (!effort) return
  const input = Array.isArray(body.input) ? body.input : undefined
  state.effortUpdates ??= []
  const updates = state.effortUpdates
  const fingerprint = (item: unknown) =>
    createHash('sha256')
      .update(stableStringify(item))
      .digest('hex')
      .slice(0, 16)
  if (
    state.pinnedEffort === undefined ||
    updates.some(
      (update) =>
        !input ||
        !isMessageWithRole(input[update.anchor], 'user') ||
        fingerprint(input[update.anchor]) !== update.fingerprint,
    )
  ) {
    state.pinnedEffort = effort
    state.effortUpdates = []
    return
  }
  if (!input || input.length === 0) return
  const anchor = input.findLastIndex((item) => isMessageWithRole(item, 'user'))
  const latest = updates.at(-1)
  const effective = latest?.effort ?? state.pinnedEffort
  if (anchor >= 0 && effort !== effective) {
    if (latest?.anchor === anchor) {
      const before = updates.at(-2)?.effort ?? state.pinnedEffort
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
    state.pinnedEffort = effort
    state.effortUpdates = []
    return
  }
  body.reasoning = { ...reasoning, effort: state.pinnedEffort }
  if (updates.length === 0) return
  // Don't mutate the host's array. Inserting from the highest anchor down
  // keeps the lower ones valid. Each update goes before a different user
  // message, so two updates are never adjacent.
  const replay = input.slice()
  for (let i = updates.length - 1; i >= 0; i--) {
    const update = updates[i]
    if (!update) continue
    replay.splice(update.anchor, 0, {
      type: 'configuration_update',
      reasoning: { effort: update.effort },
    })
  }
  body.input = replay
}
