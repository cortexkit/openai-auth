import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadModelsDevCosts,
  resetModelCostsForTest,
  toSdkCost,
} from '../model-costs'
import { FLOOR_MODELS_CACHE } from './setup-env'

const REAL_CATALOG_COST = {
  input: 5,
  output: 30,
  cache_read: 0.5,
  cache_write: 6.25,
  tiers: [
    {
      input: 10,
      output: 45,
      cache_read: 1,
      cache_write: 12.5,
      tier: { type: 'context', size: 272_000 },
    },
  ],
  context_over_200k: {
    input: 10,
    output: 45,
    cache_read: 1,
    cache_write: 12.5,
  },
}

function failingFetch(message: string): typeof globalThis.fetch {
  return Object.assign(
    async () => {
      throw new Error(message)
    },
    {
      preconnect: (
        ..._args: Parameters<typeof globalThis.fetch.preconnect>
      ) => {},
    },
  )
}

describe('models.dev costs', () => {
  let dir: string
  let cachePath: string
  let restoreModelsCache: string
  let restoreFetch: typeof globalThis.fetch

  beforeEach(() => {
    restoreModelsCache =
      process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE ?? FLOOR_MODELS_CACHE
    restoreFetch = globalThis.fetch
    dir = mkdtempSync(join(tmpdir(), 'oai-model-costs-'))
    cachePath = join(dir, 'models.json')
    process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = cachePath
    resetModelCostsForTest()
  })

  afterEach(() => {
    process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = restoreModelsCache
    globalThis.fetch = restoreFetch
    resetModelCostsForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  it('loads OpenAI prices from the overridden host cache path', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        openai: {
          models: {
            'gpt-5.6-sol': { cost: REAL_CATALOG_COST },
          },
        },
      }),
    )

    const catalog = await loadModelsDevCosts()

    expect(catalog?.['gpt-5.6-sol']).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0.5, write: 6.25 },
      tiers: [
        {
          input: 10,
          output: 45,
          cache: { read: 1, write: 12.5 },
          tier: { type: 'context', size: 272_000 },
        },
      ],
      experimentalOver200K: {
        input: 10,
        output: 45,
        cache: { read: 1, write: 12.5 },
      },
    })
  })

  it('maps flat cache, tier, and over-200k fields into the SDK shape', () => {
    expect(toSdkCost(REAL_CATALOG_COST)).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0.5, write: 6.25 },
      tiers: [
        {
          input: 10,
          output: 45,
          cache: { read: 1, write: 12.5 },
          tier: { type: 'context', size: 272_000 },
        },
      ],
      experimentalOver200K: {
        input: 10,
        output: 45,
        cache: { read: 1, write: 12.5 },
      },
    })
  })

  it('defaults missing cache prices to zero', () => {
    expect(toSdkCost({ input: 5, output: 30 })).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0, write: 0 },
    })
  })

  it('rejects a model when either required price is missing or non-finite', () => {
    expect(toSdkCost({ input: Number.NaN, output: undefined })).toBeNull()
    expect(toSdkCost({ input: 5 })).toBeNull()
    expect(toSdkCost({ input: 5, output: Number.POSITIVE_INFINITY })).toBeNull()
    expect(toSdkCost({ input: '5', output: 30 })).toBeNull()
    expect(toSdkCost({ output: 30 })).toBeNull()
  })

  it('drops malformed tier entries instead of defaulting their size to zero', () => {
    expect(
      toSdkCost({
        input: 5,
        output: 30,
        tiers: [
          'garbage',
          { input: 10, output: 45, tier: { size: Number.NaN } },
          { input: 10, output: 45, tier: { size: 0 } },
          { input: 10, output: 45, tier: { size: -5 } },
          { input: 10, tier: { size: 300_000 } },
          { input: 10, output: Number.NaN, tier: { size: 300_000 } },
          {
            input: 10,
            output: 45,
            cache_read: 1,
            tier: { size: 272_000 },
          },
        ],
      }),
    ).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0, write: 0 },
      tiers: [
        {
          input: 10,
          output: 45,
          cache: { read: 1, write: 0 },
          tier: { type: 'context', size: 272_000 },
        },
      ],
    })
  })

  it('omits tiers entirely when every entry is malformed', () => {
    expect(
      toSdkCost({
        input: 5,
        output: 30,
        tiers: [{ input: 10, output: 45, tier: { size: 0 } }],
      }),
    ).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0, write: 0 },
    })
  })

  it('omits over-200k pricing when its required prices are malformed', () => {
    expect(
      toSdkCost({
        input: 5,
        output: 30,
        context_over_200k: { input: 10 },
      }),
    ).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0, write: 0 },
    })
    expect(
      toSdkCost({
        input: 5,
        output: 30,
        context_over_200k: { input: 10, output: Number.NaN },
      }),
    ).toEqual({
      input: 5,
      output: 30,
      cache: { read: 0, write: 0 },
    })
  })

  it('returns null without throwing when cache and network are unavailable', async () => {
    globalThis.fetch = failingFetch('network unavailable')

    await expect(loadModelsDevCosts()).resolves.toBeNull()
  })
})
