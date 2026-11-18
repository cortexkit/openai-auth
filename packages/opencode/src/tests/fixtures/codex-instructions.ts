import { expect } from 'bun:test'

export function expectedBaseInstructions(
  text: unknown,
  { id, lite = false }: { id?: string; lite?: boolean } = {},
) {
  return {
    type: 'message',
    id:
      id ??
      expect.stringMatching(
        /^msg_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      ),
    role: 'developer',
    content: [{ type: 'input_text', text }],
    internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['model.base_instructions'],
      ...(lite && {
        content_item_metadata: [
          { provenance: { type: 'harness', hook: false } },
        ],
      }),
    },
  }
}
