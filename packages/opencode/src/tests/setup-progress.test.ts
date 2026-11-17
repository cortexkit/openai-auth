import { expect, test } from 'bun:test'
import { createProcessFence } from '@cortexkit/common-auth/setup'
import { createSetupPlugin } from '../setup'

test('the default process fence prints its slow-check progress through setup output', () => {
  const calls: Parameters<typeof createProcessFence>[] = []
  const lines: string[] = []
  createSetupPlugin({
    print: (line) => lines.push(line),
    createFence: (...args) => {
      calls.push(args)
      return createProcessFence(...args)
    },
  })
  expect(calls).toHaveLength(1)
  calls[0]?.[1]?.onProgress?.('Checking for running hosts')
  expect(lines).toEqual(['Checking for running hosts'])
})
