import { expect, test } from 'bun:test'
import { supportsMidConversationEffort } from '../internal'

test('mid-conversation effort applies only to GPT major versions 6 and later', () => {
  const models = {
    'gpt-6': true,
    'gpt-6-astra': true,
    'gpt-6-sol': true,
    'gpt-6-luna': true,
    'gpt-6.1-sol': true,
    'gpt-6.1-terra': true,
    'gpt-6.2-sol': true,
    'gpt-7': true,
    'gpt-7.1-sol': true,
    'gpt-10-sol': true,
    'gpt-5.6-sol': false,
    'other-6.2': false,
    'gpt-next': false,
    'provider/gpt-6.2-sol': false,
  }
  for (const [model, expected] of Object.entries(models))
    expect({ model, supports: supportsMidConversationEffort(model) }).toEqual({
      model,
      supports: expected,
    })
})
