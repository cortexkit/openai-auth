import { expect, test } from 'bun:test'
import type { Plugin } from '@opencode/plugin/tui'
import { setupTui } from '../tui/v2'

test('OpenCode 2 transport stays invisible without a menu or sidebar owner', async () => {
  let slots = 0
  let dialogs = 0
  const context = {
    ui: {
      slot: () => {
        slots++
        return () => {}
      },
      dialog: {
        clear: () => {
          dialogs++
        },
      },
      router: { current: () => ({ type: 'home' }) },
    },
  } as unknown as Plugin.Context
  const dispose = await setupTui(context)
  try {
    expect(slots).toBe(0)
    expect(dialogs).toBe(0)
  } finally {
    dispose()
  }
  expect(dialogs).toBe(0)
})
