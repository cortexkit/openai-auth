import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../index'
import { type ModelCost, resetModelCostsForTest } from '../model-costs'
import {
  FLOOR_AUTH_FILE,
  FLOOR_MODELS_CACHE,
  FLOOR_STATE_FILE,
} from './setup-env'

// Exercises the provider.models hook: which OpenAI models surface to OAuth
// users and what context limits they carry. The suffix-less gpt-5.6 (and its
// -fast/-pro synthetics, which inherit api.id "gpt-5.6") must be dropped
// because the Codex OAuth backend rejects that model name; the -luna/-sol/-terra
// variants stay and get the real 372k context window.

function createMockPluginInput(): PluginInput {
  return {
    client: {
      auth: { set: async () => {} },
      session: { promptAsync: async () => {} },
    } as unknown as PluginInput['client'],
    project: { id: 'test', name: 'test' } as unknown as PluginInput['project'],
    directory: '',
    worktree: '/tmp/test-worktree',
    experimental_workspace: { register: () => {} },
    serverUrl: new URL('http://localhost:0'),
    $: {} as PluginInput['$'],
  }
}

type MockModel = {
  id: string
  api: { id: string }
  cost: ModelCost
  limit: { context: number; input: number; output: number }
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

function model(id: string, apiId: string): MockModel {
  return {
    id,
    api: { id: apiId },
    cost: { input: 5, output: 10, cache: { read: 1, write: 2 } },
    limit: { context: 1_050_000, input: 922_000, output: 128_000 },
  }
}

async function surfacedModels() {
  const hooks = await CodexAuthPlugin(createMockPluginInput(), {
    experimentalWebSockets: false,
  })
  const modelsHook = hooks.provider?.models
  if (!modelsHook) throw new Error('No provider.models hook')

  const provider = {
    models: {
      // <= 5.4 non-allowlisted: dropped
      'gpt-4.1': model('gpt-4.1', 'gpt-4.1'),
      // allow-listed
      'gpt-5.4': model('gpt-5.4', 'gpt-5.4'),
      'gpt-5.5': model('gpt-5.5', 'gpt-5.5'),
      // suffix-less 5.6 + synthetics (all inherit api.id "gpt-5.6"): dropped
      'gpt-5.6': model('gpt-5.6', 'gpt-5.6'),
      'gpt-5.6-fast': model('gpt-5.6-fast', 'gpt-5.6'),
      'gpt-5.6-pro': model('gpt-5.6-pro', 'gpt-5.6'),
      // real 5.6 variants (api.id carries the suffix): kept
      'gpt-5.6-luna': model('gpt-5.6-luna', 'gpt-5.6-luna'),
      'gpt-5.6-luna-fast': model('gpt-5.6-luna-fast', 'gpt-5.6-luna'),
      'gpt-5.6-sol': model('gpt-5.6-sol', 'gpt-5.6-sol'),
      'gpt-5.6-terra': model('gpt-5.6-terra', 'gpt-5.6-terra'),
    },
  }

  const ctx = { auth: { type: 'oauth' } }
  const result = (await modelsHook(provider as never, ctx as never)) as Record<
    string,
    MockModel
  >
  return result
}

describe('provider.models filter', () => {
  let dir: string
  let configPath: string
  let modelsCachePath: string
  let restoreFile: string
  let restoreState: string
  let restoreModelsCache: string
  let restoreFetch: typeof globalThis.fetch

  beforeEach(() => {
    restoreFile = process.env.OPENCODE_OPENAI_AUTH_FILE ?? FLOOR_AUTH_FILE
    restoreState =
      process.env.OPENCODE_OPENAI_AUTH_STATE_FILE ?? FLOOR_STATE_FILE
    restoreModelsCache =
      process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE ?? FLOOR_MODELS_CACHE
    restoreFetch = globalThis.fetch
    dir = mkdtempSync(join(tmpdir(), 'oai-modelfilter-'))
    configPath = join(dir, 'openai-auth.json')
    modelsCachePath = join(dir, 'models.json')
    // Point at nonexistent files so loadAccounts returns null (cost-zeroing on).
    process.env.OPENCODE_OPENAI_AUTH_FILE = configPath
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
      dir,
      'openai-auth-state.json',
    )
    process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = modelsCachePath
    resetModelCostsForTest()
  })

  afterEach(() => {
    process.env.OPENCODE_OPENAI_AUTH_FILE = restoreFile
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = restoreState
    process.env.OPENCODE_OPENAI_AUTH_MODELS_CACHE = restoreModelsCache
    globalThis.fetch = restoreFetch
    resetModelCostsForTest()
    rmSync(dir, { recursive: true, force: true })
  })

  it('restores catalog prices when incoming OAuth costs were pre-zeroed', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        costZeroing: { enabled: false },
        accounts: [],
      }),
    )
    writeFileSync(
      modelsCachePath,
      JSON.stringify({
        openai: {
          models: {
            'gpt-5.6-sol': {
              cost: {
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
              },
            },
          },
        },
      }),
    )

    const hooks = await CodexAuthPlugin(createMockPluginInput(), {
      experimentalWebSockets: false,
    })
    const modelsHook = hooks.provider?.models
    if (!modelsHook) throw new Error('No provider.models hook')
    const incoming = model('gpt-5.6-sol', 'gpt-5.6-sol')
    incoming.cost = { input: 0, output: 0, cache: { read: 0, write: 0 } }

    const result = (await modelsHook(
      { models: { 'gpt-5.6-sol': incoming } } as never,
      { auth: { type: 'oauth' } } as never,
    )) as Record<string, MockModel>

    expect(result['gpt-5.6-sol']?.cost).toEqual({
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

  it('keeps zeroing enabled even when catalog prices are available', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        costZeroing: { enabled: true },
        accounts: [],
      }),
    )
    writeFileSync(
      modelsCachePath,
      JSON.stringify({
        openai: {
          models: {
            'gpt-5.6-sol': {
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
                cache_write: 6.25,
              },
            },
          },
        },
      }),
    )

    const hooks = await CodexAuthPlugin(createMockPluginInput(), {
      experimentalWebSockets: false,
    })
    const modelsHook = hooks.provider?.models
    if (!modelsHook) throw new Error('No provider.models hook')
    const result = (await modelsHook(
      {
        models: { 'gpt-5.6-sol': model('gpt-5.6-sol', 'gpt-5.6-sol') },
      } as never,
      { auth: { type: 'oauth' } } as never,
    )) as Record<string, MockModel>

    expect(result['gpt-5.6-sol']?.cost).toEqual({
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    })
  })

  it('preserves incoming costs when the catalog is unavailable', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        costZeroing: { enabled: false },
        accounts: [],
      }),
    )
    globalThis.fetch = failingFetch('network unavailable')

    const hooks = await CodexAuthPlugin(createMockPluginInput(), {
      experimentalWebSockets: false,
    })
    const modelsHook = hooks.provider?.models
    if (!modelsHook) throw new Error('No provider.models hook')
    const incoming = model('gpt-5.6-sol', 'gpt-5.6-sol')

    const result = (await modelsHook(
      { models: { 'gpt-5.6-sol': incoming } } as never,
      { auth: { type: 'oauth' } } as never,
    )) as Record<string, MockModel>

    expect(result['gpt-5.6-sol']?.cost).toEqual(incoming.cost)
  })

  it('looks up catalog costs by API id before falling back to model id', async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        costZeroing: { enabled: false },
        accounts: [],
      }),
    )
    writeFileSync(
      modelsCachePath,
      JSON.stringify({
        openai: {
          models: {
            'gpt-5.6-sol': {
              cost: {
                input: 5,
                output: 30,
                cache_read: 0.5,
                cache_write: 6.25,
              },
            },
            'gpt-5.6-terra': {
              cost: {
                input: 7,
                output: 31,
                cache_read: 0.7,
                cache_write: 7.25,
              },
            },
          },
        },
      }),
    )

    const hooks = await CodexAuthPlugin(createMockPluginInput(), {
      experimentalWebSockets: false,
    })
    const modelsHook = hooks.provider?.models
    if (!modelsHook) throw new Error('No provider.models hook')
    const result = (await modelsHook(
      {
        models: {
          'gpt-5.6-sol-fast': model('gpt-5.6-sol-fast', 'gpt-5.6-sol'),
          'gpt-5.6-terra': model('gpt-5.6-terra', 'gpt-5.6-terra-catalog-miss'),
        },
      } as never,
      { auth: { type: 'oauth' } } as never,
    )) as Record<string, MockModel>

    expect(result['gpt-5.6-sol-fast']?.cost.input).toBe(5)
    expect(result['gpt-5.6-terra']?.cost.input).toBe(7)
  })

  it('drops the suffix-less gpt-5.6 and its -fast/-pro synthetics', async () => {
    const models = await surfacedModels()
    expect(models['gpt-5.6']).toBeUndefined()
    expect(models['gpt-5.6-fast']).toBeUndefined()
    expect(models['gpt-5.6-pro']).toBeUndefined()
  })

  it('keeps the -luna/-sol/-terra variants (including their -fast synthetics)', async () => {
    const models = await surfacedModels()
    expect(models['gpt-5.6-luna']).toBeDefined()
    expect(models['gpt-5.6-luna-fast']).toBeDefined()
    expect(models['gpt-5.6-sol']).toBeDefined()
    expect(models['gpt-5.6-terra']).toBeDefined()
  })

  it('keeps allow-listed models and drops pre-5.4 models', async () => {
    const models = await surfacedModels()
    expect(models['gpt-5.4']).toBeDefined()
    expect(models['gpt-5.5']).toBeDefined()
    expect(models['gpt-4.1']).toBeUndefined()
  })

  it('assigns gpt-5.6 variants the real 372k context window', async () => {
    const models = await surfacedModels()
    expect(models['gpt-5.6-luna']?.limit).toEqual({
      context: 372_000,
      input: 244_000,
      output: 128_000,
    })
  })

  it('keeps the gpt-5.5 400k downshift', async () => {
    const models = await surfacedModels()
    expect(models['gpt-5.5']?.limit).toEqual({
      context: 400_000,
      input: 272_000,
      output: 128_000,
    })
  })
})
