import { describe, expect, test } from 'bun:test'
import {
  canonicalInput,
  canonicalPrefixLength,
  retainedInput,
} from '../util/canonical-input'
import { stableStringify } from '../util/stable-json'

const history = () => [
  {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'inspect' }],
  },
  { type: 'reasoning', summary: [{ text: 'think', type: 'summary_text' }] },
  {
    type: 'function_call',
    call_id: 'c',
    name: 'read',
    arguments: '{"path":"a"}',
  },
  { type: 'function_call_output', call_id: 'c', output: 'contents' },
]

function legacyPrefix(prefix: unknown[], input: unknown[]) {
  if (prefix.length > input.length) return undefined
  return prefix.every(
    (item, i) => stableStringify(item) === stableStringify(input[i]),
  )
    ? prefix.length
    : undefined
}

describe('canonical input', () => {
  test('matches the original exact comparison on varied histories', () => {
    const prior = history()
    const cached = canonicalInput(prior)
    const cases: unknown[][] = [
      JSON.parse(JSON.stringify(prior)),
      [
        ...prior,
        { type: 'function_call_output', call_id: 'd', output: 'more' },
      ],
      [
        { ...prior[0], content: [{ text: 'edited', type: 'input_text' }] },
        ...prior.slice(1),
      ],
      prior.slice(2),
      [...prior].reverse(),
      [
        {
          role: 'user',
          content: [{ text: 'inspect', type: 'input_text' }],
          type: 'message',
        },
        ...prior.slice(1),
      ],
      [],
    ]
    for (const input of cases) {
      const next = canonicalInput(input, cached)
      expect(next.texts).toEqual(input.map(stableStringify))
      expect(canonicalPrefixLength(cached, next)).toBe(
        legacyPrefix(prior, input),
      )
    }
    // Non-JSON values used by direct callers must retain the old canonical
    // equivalences too, even though transport requests cannot contain them.
    for (const input of [
      [undefined, null, Number.NaN],
      [{ a: undefined, b: -0 }],
      [[undefined, Number.POSITIVE_INFINITY]],
    ]) {
      const first = canonicalInput(input)
      const second = canonicalInput(input, first)
      expect(second.texts).toEqual(input.map(stableStringify))
    }
  })

  test('rejects a stale canonical item after an earlier in-place edit', () => {
    const input = history()
    const prior = canonicalInput(input)
    input[0]!.content![0]!.text = 'rewritten earlier message'
    const next = canonicalInput(input, prior)
    expect(next.texts[0]).toBe(stableStringify(input[0]))
    expect(canonicalPrefixLength(prior, next)).toBeUndefined()
  })

  test('reuses detached snapshots only for unchanged items and bounds retention', () => {
    const input = history()
    const prior = canonicalInput(input)
    const next = canonicalInput(JSON.parse(JSON.stringify(input)), prior)
    expect(next.snapshots[0]).toBe(prior.snapshots[0])
    expect(next.snapshots[0]).not.toBe(input[0])
    const edited = canonicalInput(
      [{ ...input[0], role: 'developer' }, ...input.slice(1)],
      next,
    )
    expect(edited.snapshots[0]).not.toBe(next.snapshots[0])
    expect(retainedInput(edited)).toBe(edited)
    expect(retainedInput(canonicalInput(Array(513).fill(null)))).toBeUndefined()
    expect(
      retainedInput(canonicalInput(['x'.repeat(2 * 1024 * 1024)])),
    ).toBeUndefined()
  })
})
