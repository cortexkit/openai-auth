import { describe, expect, it } from 'bun:test'
import { resolvePromptContext } from '../prompt-context'

// Guards the model-switch fix: a hidden /openai-* command reply must carry the
// last assistant's model/agent/variant so OpenCode's next real prompt does not
// inherit a synthetic default and silently switch the model (e.g. drop -pro).

function clientWith(messages: unknown[]) {
  return {
    session: {
      messages: async () => ({ data: messages }),
    },
  }
}

function assistant(model?: {
  providerID: string
  modelID: string
  variant?: string
}) {
  return { info: { role: 'assistant', agent: 'build', model } }
}

describe('resolvePromptContext', () => {
  it('resolves model/agent/variant from the last assistant message', async () => {
    const ctx = await resolvePromptContext(
      clientWith([
        assistant({
          providerID: 'openai',
          modelID: 'gpt-5.6-sol-pro',
          variant: 'xhigh',
        }),
      ]),
      'ses_1',
    )
    expect(ctx).toEqual({
      agent: 'build',
      model: { providerID: 'openai', modelID: 'gpt-5.6-sol-pro' },
      variant: 'xhigh',
    })
  })

  it('prefers the most recent assistant over an older one', async () => {
    const ctx = await resolvePromptContext(
      clientWith([
        assistant({ providerID: 'openai', modelID: 'gpt-5.6-sol' }),
        { info: { role: 'user' } },
        assistant({
          providerID: 'openai',
          modelID: 'gpt-5.6-luna-pro',
          variant: 'high',
        }),
      ]),
      'ses_1',
    )
    expect(ctx?.model?.modelID).toBe('gpt-5.6-luna-pro')
    expect(ctx?.variant).toBe('high')
  })

  it('returns null when there are no messages', async () => {
    const ctx = await resolvePromptContext(clientWith([]), 'ses_1')
    expect(ctx).toBeNull()
  })

  it('returns null when the client has no session.messages', async () => {
    const ctx = await resolvePromptContext({ session: {} }, 'ses_1')
    expect(ctx).toBeNull()
  })

  it('returns null for an empty session id', async () => {
    const ctx = await resolvePromptContext(
      clientWith([assistant({ providerID: 'openai', modelID: 'gpt-5.6-sol' })]),
      '',
    )
    expect(ctx).toBeNull()
  })
})
