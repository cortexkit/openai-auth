import { expect, test } from 'bun:test'
import { codexBillingUsage } from '../vault-billing'

test('Codex billing subtracts cache reads and nested cache writes', () => {
  expect(
    codexBillingUsage({
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 40, cache_write_tokens: 60 },
    }),
  ).toEqual({
    input: 20,
    cacheRead: 40,
    cacheWrite: 60,
    reasoningIncludedInOutput: true,
  })
})
