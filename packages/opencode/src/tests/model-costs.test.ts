import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  let restoreModelsPath: string | undefined
  let restoreDisableFetch: string | undefined
  let restoreXdgCacheHome: string | undefined
  let restoreLocalAppData: string | undefined
  let restoreFetch: typeof globalThis.fetch

  beforeEach(() => {
    restoreModelsCache =
      process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE ?? FLOOR_MODELS_CACHE
    restoreModelsPath = process.env.OPENCODE_MODELS_PATH
    restoreDisableFetch = process.env.OPENCODE_DISABLE_MODELS_FETCH
    restoreXdgCacheHome = process.env.XDG_CACHE_HOME
    restoreLocalAppData = process.env.LOCALAPPDATA
    restoreFetch = globalThis.fetch
    dir = mkdtempSync(join(tmpdir(), 'oai-model-costs-'))
    cachePath = join(dir, 'models.json')
    process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = cachePath
    resetModelCostsForTest()
  })

  afterEach(() => {
    process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = restoreModelsCache
    if (restoreModelsPath === undefined) delete process.env.OPENCODE_MODELS_PATH
    else process.env.OPENCODE_MODELS_PATH = restoreModelsPath
    if (restoreDisableFetch === undefined)
      delete process.env.OPENCODE_DISABLE_MODELS_FETCH
    else process.env.OPENCODE_DISABLE_MODELS_FETCH = restoreDisableFetch
    if (restoreXdgCacheHome === undefined) delete process.env.XDG_CACHE_HOME
    else process.env.XDG_CACHE_HOME = restoreXdgCacheHome
    if (restoreLocalAppData === undefined) delete process.env.LOCALAPPDATA
    else process.env.LOCALAPPDATA = restoreLocalAppData
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

  it('honors the host models path when no plugin override is set', async () => {
    const hostPath = join(dir, 'host-models.json')
    writeFileSync(
      hostPath,
      JSON.stringify({
        openai: {
          models: { 'gpt-5.6-sol': { cost: REAL_CATALOG_COST } },
        },
      }),
    )
    delete process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE
    process.env.OPENCODE_MODELS_PATH = hostPath
    globalThis.fetch = failingFetch('network must not be needed')
    resetModelCostsForTest()

    expect((await loadModelsDevCosts())?.['gpt-5.6-sol']?.input).toBe(5)
  })

  it('honors XDG_CACHE_HOME for the default host cache path', async () => {
    const xdgCache = join(dir, 'xdg-cache')
    const hostCacheDir = join(xdgCache, 'opencode')
    mkdirSync(hostCacheDir, { recursive: true })
    writeFileSync(
      join(hostCacheDir, 'models.json'),
      JSON.stringify({
        openai: {
          models: { 'gpt-5.6-sol': { cost: REAL_CATALOG_COST } },
        },
      }),
    )
    delete process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE
    delete process.env.OPENCODE_MODELS_PATH
    process.env.XDG_CACHE_HOME = xdgCache
    globalThis.fetch = failingFetch('network must not be needed')
    resetModelCostsForTest()

    expect((await loadModelsDevCosts())?.['gpt-5.6-sol']?.input).toBe(5)
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
    expect(toSdkCost({ input: -1, output: 30 })).toBeNull()
    expect(toSdkCost({ input: 5, output: -1 })).toBeNull()
    expect(toSdkCost({ input: 5, output: 30, cache_read: -1 })).toBeNull()
    expect(toSdkCost({ input: 5, output: 30, cache_write: -1 })).toBeNull()
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
            tier: { type: 'context', size: 272_000 },
          },
          {
            input: 10,
            output: 45,
            tier: { type: 'tokens', size: 272_000 },
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

  it('respects the host setting that disables models.dev fetches', async () => {
    let fetchCalls = 0
    globalThis.fetch = Object.assign(
      async () => {
        fetchCalls += 1
        return new Response('{}')
      },
      { preconnect: () => {} },
    )
    process.env.OPENCODE_DISABLE_MODELS_FETCH = '1'

    await expect(loadModelsDevCosts()).resolves.toBeNull()
    expect(fetchCalls).toBe(0)
  })

  it('retries after a transient catalog miss without a process restart', async () => {
    globalThis.fetch = failingFetch('network unavailable')
    await expect(loadModelsDevCosts()).resolves.toBeNull()

    writeFileSync(
      cachePath,
      JSON.stringify({
        openai: {
          models: { 'gpt-5.6-sol': { cost: REAL_CATALOG_COST } },
        },
      }),
    )

    expect((await loadModelsDevCosts())?.['gpt-5.6-sol']?.input).toBe(5)
  })

  it('treats a catalog with no valid prices as unavailable', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({
        openai: {
          models: {
            broken: { cost: { input: -1, output: 30 } },
          },
        },
      }),
    )
    process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true'

    await expect(loadModelsDevCosts()).resolves.toBeNull()
  })
})
