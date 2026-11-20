import { gptModelVersion } from './codex-models'
import { isRecord } from './util/record'

/**
 * GPT-6.2 and later can discard replayed reasoning if an earlier tool call
 * differs from what the backend emitted. Restore the missing completion status.
 */
export function restoreReplayedCallStatus(
  input: unknown,
  model: unknown,
): unknown {
  if (!Array.isArray(input) || typeof model !== 'string') return input
  const version = gptModelVersion(model)
  if (!version) return input
  const [major, minor = '0'] = version.split('.')
  if (Number(major) < 6 || (Number(major) === 6 && Number(minor) < 2))
    return input

  let restored: unknown[] | undefined
  for (let index = 0; index < input.length; index++) {
    const item: unknown = input[index]
    if (
      !isRecord(item) ||
      item.type !== 'function_call' ||
      Object.hasOwn(item, 'status')
    )
      continue
    restored ??= input.slice()
    restored[index] = { ...item, status: 'completed' }
  }
  return restored ?? input
}
