import { expect, test } from 'bun:test'
import { moveInstructionsToDeveloperMessage } from '../codex-instructions'

test('serializes the base instructions in Codex wire order with a UUIDv5 id', () => {
  const body: Record<string, unknown> = {
    prompt_cache_key: 'thread-123',
    instructions: 'Be precise. ☕',
    input: [{ type: 'message', role: 'user', content: 'first turn' }],
  }
  moveInstructionsToDeveloperMessage(body)
  const [instructions] = body.input as unknown[]
  // Python uuid.uuid5(uuid.uuid5(uuid.NAMESPACE_OID, key), text).
  expect(JSON.stringify(instructions)).toBe(
    '{"type":"message","id":"msg_c75d4276-d6cf-5fa4-a56a-21d6f35d0c08","role":"developer","content":[{"type":"input_text","text":"Be precise. ☕"}],"internal_chat_message_metadata_passthrough":{"content_item_kinds":["model.base_instructions"]}}',
  )

  const later: Record<string, unknown> = {
    prompt_cache_key: 'thread-123',
    instructions: 'Be precise. ☕',
    input: [{ type: 'message', role: 'user', content: 'later turn' }],
  }
  moveInstructionsToDeveloperMessage(later)
  expect((later.input as unknown[])[0]).toEqual(instructions)
})

test.each([
  ['missing', {}],
  ['non-string', { prompt_cache_key: 123 }],
])(
  'omits the id for a %s cache key but keeps the content kind',
  (_, cacheKey) => {
    const body: Record<string, unknown> = {
      ...cacheKey,
      instructions: 'system',
    }
    moveInstructionsToDeveloperMessage(body)
    expect(body.input).toStrictEqual([
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'system' }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ['model.base_instructions'],
        },
      },
    ])
  },
)
