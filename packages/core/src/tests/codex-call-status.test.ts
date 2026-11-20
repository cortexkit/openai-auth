import { expect, test } from 'bun:test'
import { restoreReplayedCallStatus } from '../codex-call-status'

const call = Object.freeze({
  type: 'function_call',
  name: 'read',
  call_id: 'c1',
  id: 'fc_1',
  arguments: '{ "z": 1.0, "a": "é" }',
})

test('restores replayed call status only on GPT-6.2 and later', () => {
  const input = [call]
  for (const model of [
    'gpt-6.1-sol',
    'gpt-6-astra',
    'gpt-5.6-sol',
    'other-6.2',
    undefined,
  ]) {
    expect(restoreReplayedCallStatus(input, model)).toBe(input)
  }
  for (const model of [
    'gpt-6.2-sol',
    'gpt-6.3-astra',
    'gpt-6.10-sol',
    'gpt-7-astra',
  ]) {
    expect(restoreReplayedCallStatus(input, model)).toEqual([
      { ...call, status: 'completed' },
    ])
  }
})

test('appends only missing function call status without copying or changing other items', () => {
  const others = [
    Object.freeze({ type: 'reasoning', encrypted_content: 'opaque' }),
    Object.freeze({
      type: 'function_call_output',
      call_id: 'c1',
      output: 'ok',
    }),
    Object.freeze({ type: 'custom_tool_call', call_id: 'c2', input: 'raw' }),
    Object.freeze({ ...call, status: 'in_progress', call_id: 'c3' }),
    Object.freeze({ ...call, status: null }),
    Object.freeze({ ...call, status: undefined }),
    null,
  ]
  const input = Object.freeze([call, ...others, { ...call, id: 'fc_2' }])
  const original = JSON.stringify(input)
  const restored = restoreReplayedCallStatus(input, 'gpt-6.2-sol')
  expect(restored).not.toBe(input)
  expect(JSON.stringify(restored)).toBe(
    JSON.stringify([
      { ...call, status: 'completed' },
      ...others,
      { ...call, id: 'fc_2', status: 'completed' },
    ]),
  )
  const items = restored as unknown[]
  expect(items[0]).not.toBe(call)
  for (const [index, item] of others.entries())
    expect(items[index + 1]).toBe(item)
  expect(JSON.stringify(input)).toBe(original)
  expect(restoreReplayedCallStatus(restored, 'gpt-6.2-sol')).toBe(restored)
  expect(restoreReplayedCallStatus(others, 'gpt-6.2-sol')).toBe(others)
  expect(restoreReplayedCallStatus('text', 'gpt-6.2-sol')).toBe('text')
})
