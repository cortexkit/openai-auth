import { createHash } from 'node:crypto'
import { isRecord } from './util/record'

const OID_NAMESPACE = Buffer.from('6ba7b8129dad11d180b400c04fd430c8', 'hex')

function uuidV5(namespace: Buffer, name: string): Buffer {
  const bytes = createHash('sha1')
    .update(namespace)
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes.readUInt8(6) & 0x0f) | 0x50
  bytes[8] = (bytes.readUInt8(8) & 0x3f) | 0x80
  return bytes
}

function baseInstructionsId(threadId: string, text: string): string {
  const hex = uuidV5(uuidV5(OID_NAMESPACE, threadId), text).toString('hex')
  return `msg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

// GPT-6.2 caches the system prompt in input, but not in top-level instructions.
export function moveInstructionsToDeveloperMessage(
  body: Record<string, unknown>,
  options?: { responsesLite?: boolean; leadingBareInstructions?: boolean },
) {
  const topLevel = body.instructions
  const hasTopLevel = typeof topLevel === 'string' && topLevel.length > 0
  if (!hasTopLevel && !options?.leadingBareInstructions) return
  const items = Array.isArray(body.input)
    ? body.input
    : typeof body.input === 'string'
      ? [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: body.input }],
          },
        ]
      : []
  const first = items[0]
  let at = isRecord(first) && first.type === 'additional_tools' ? 1 : 0
  let replace = false
  let instructions: string
  // Explicit instructions already supply the base prompt. Leave existing
  // input alone in that case, rather than interpreting a second prompt.
  if (hasTopLevel) {
    instructions = topLevel
  } else {
    while (isRecord(items[at]) && items[at].type === 'additional_tools') at++
    const leading = items[at]
    if (
      !isRecord(leading) ||
      (leading.role !== 'developer' && leading.role !== 'system') ||
      typeof leading.content !== 'string' ||
      leading.content.length === 0 ||
      Object.keys(leading).length !== 2
    )
      return
    instructions = leading.content
    replace = true
  }
  const threadId = body.prompt_cache_key
  body.input = [
    ...items.slice(0, at),
    {
      type: 'message',
      ...(typeof threadId === 'string' && {
        id: baseInstructionsId(threadId, instructions),
      }),
      role: 'developer',
      content: [{ type: 'input_text', text: instructions }],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['model.base_instructions'],
        // Only Responses Lite accepts per-content attribution.
        ...(options?.responsesLite && {
          content_item_metadata: [
            { provenance: { type: 'harness', hook: false } },
          ],
        }),
      },
    },
    ...items.slice(replace ? at + 1 : at),
  ]
  delete body.instructions
}
