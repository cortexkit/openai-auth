import { isRecord } from './util/record'

// GPT-6.2 caches the system prompt in input, but not in top-level instructions.
export function moveInstructionsToDeveloperMessage(
  body: Record<string, unknown>,
) {
  const instructions = body.instructions
  if (typeof instructions !== 'string' || instructions.length === 0) return
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
  const at = isRecord(first) && first.type === 'additional_tools' ? 1 : 0
  body.input = [
    ...items.slice(0, at),
    {
      type: 'message',
      role: 'developer',
      content: [{ type: 'input_text', text: instructions }],
    },
    ...items.slice(at),
  ]
  delete body.instructions
}
