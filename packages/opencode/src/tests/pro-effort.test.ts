import { describe, expect, it } from 'bun:test'
import type { PluginInput } from '@opencode-ai/plugin'
import { CodexAuthPlugin } from '../index'

// Exercises the -pro reasoning path. OpenCode's `-pro` moniker (a separate model
// id, e.g. gpt-5.6-sol-pro) means max reasoning effort, but the pinned
// @ai-sdk/openai validates reasoningEffort against ["none".."xhigh"] and drops
// "max", and its reasoning.mode:"pro" is never emitted. So the chat.headers hook
// flags -pro via an internal header (the outer variant id is only visible there);
// the fetch layer then injects reasoning.effort:"max" onto the wire. This test
// covers the header-signal half (the hook); the wire injection is covered by the
// live dumps and prepareCodexRequest.

const HEADER = 'x-codex-reasoning-effort'

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

async function chatHeadersHook() {
  const hooks = await CodexAuthPlugin(createMockPluginInput(), {
    experimentalWebSockets: false,
  })
  const hook = (hooks as Record<string, unknown>)['chat.headers'] as (
    input: {
      model: { id: string; providerID: string }
      sessionID: string
      agent: string
    },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  if (!hook) throw new Error('No chat.headers hook')
  return hook
}

async function run(modelId: string, providerID = 'openai') {
  const hook = await chatHeadersHook()
  const output: { headers: Record<string, string> } = { headers: {} }
  await hook(
    {
      model: { id: modelId, providerID },
      sessionID: 'ses_test',
      agent: 'build',
    },
    output,
  )
  return output.headers
}

describe('chat.headers -pro → reasoning-effort signal header', () => {
  it('sets the effort header to max for a -pro variant', async () => {
    const headers = await run('gpt-5.6-sol-pro')
    expect(headers[HEADER]).toBe('max')
  })

  it('sets it for luna-pro too', async () => {
    const headers = await run('gpt-5.6-luna-pro')
    expect(headers[HEADER]).toBe('max')
  })

  it('does not set it for a non-pro model', async () => {
    const headers = await run('gpt-5.6-sol')
    expect(headers[HEADER]).toBeUndefined()
  })

  it('does not set it for -fast (priority tier is a separate mechanism)', async () => {
    const headers = await run('gpt-5.6-sol-fast')
    expect(headers[HEADER]).toBeUndefined()
  })

  it('ignores non-openai providers even when the id ends in -pro', async () => {
    const headers = await run('some-model-pro', 'anthropic')
    expect(headers[HEADER]).toBeUndefined()
  })
})
