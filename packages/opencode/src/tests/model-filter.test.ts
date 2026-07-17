import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../index'

// Exercises the provider.models hook: which OpenAI models surface to OAuth
// users and what context limits they carry. The suffix-less gpt-5.6 and its
// synthetics inherit api.id "gpt-5.6" and must be dropped because the Codex
// OAuth backend rejects that model name. Legacy reasoning-mode `-pro` models
// are also dropped; Luna/Sol/Terra use the native `max` reasoning variant.

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
  options: { reasoningMode?: string }
  cost: {
    input: number
    output: number
    cache: { read: number; write: number }
  }
  limit: { context: number; input: number; output: number }
}

function model(
  id: string,
  apiId: string,
  options: MockModel['options'] = {},
): MockModel {
  return {
    id,
    api: { id: apiId },
    options,
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
      'gpt-5.6-luna-pro': model('gpt-5.6-luna-pro', 'gpt-5.6-luna', {
        reasoningMode: 'pro',
      }),
      'gpt-5.6-sol': model('gpt-5.6-sol', 'gpt-5.6-sol'),
      'gpt-5.6-sol-pro': model('gpt-5.6-sol-pro', 'gpt-5.6-sol', {
        reasoningMode: 'pro',
      }),
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
  let restoreFile: string | undefined
  let restoreState: string | undefined

  beforeEach(() => {
    restoreFile = process.env.OPENCODE_OPENAI_AUTH_FILE
    restoreState = process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    const dir = mkdtempSync(join(tmpdir(), 'oai-modelfilter-'))
    // Point at nonexistent files so loadAccounts returns null (cost-zeroing on).
    process.env.OPENCODE_OPENAI_AUTH_FILE = join(dir, 'openai-auth.json')
    process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = join(
      dir,
      'openai-auth-state.json',
    )
  })

  afterEach(() => {
    if (restoreFile === undefined) delete process.env.OPENCODE_OPENAI_AUTH_FILE
    else process.env.OPENCODE_OPENAI_AUTH_FILE = restoreFile
    if (restoreState === undefined)
      delete process.env.OPENCODE_OPENAI_AUTH_STATE_FILE
    else process.env.OPENCODE_OPENAI_AUTH_STATE_FILE = restoreState
  })

  it('drops the suffix-less gpt-5.6 and its -fast/-pro synthetics', async () => {
    const models = await surfacedModels()
    expect(models['gpt-5.6']).toBeUndefined()
    expect(models['gpt-5.6-fast']).toBeUndefined()
    expect(models['gpt-5.6-pro']).toBeUndefined()
  })

  it('keeps the -luna/-sol/-terra models and their native reasoning variants', async () => {
    const models = await surfacedModels()
    expect(models['gpt-5.6-luna']).toBeDefined()
    expect(models['gpt-5.6-luna-fast']).toBeDefined()
    expect(models['gpt-5.6-sol']).toBeDefined()
    expect(models['gpt-5.6-terra']).toBeDefined()
  })

  it('drops legacy reasoning-mode pro models for supported 5.6 slugs', async () => {
    const models = await surfacedModels()
    expect(models['gpt-5.6-luna-pro']).toBeUndefined()
    expect(models['gpt-5.6-sol-pro']).toBeUndefined()
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
