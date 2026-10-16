import { expect, test } from 'bun:test'
import type { Plugin } from '@opencode/plugin/tui'
import type { OpenDialogPayload } from '../rpc/protocol'
import { setupTui } from '../tui/v2'
import { openReadOnlyDialog } from '../tui/v2-dialog'

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

const payload: OpenDialogPayload = {
  command: 'openai',
  menu: {
    command: 'openai',
    title: 'OpenAI',
    sections: [
      {
        id: 'accounts',
        slot: 'accounts',
        title: 'Accounts',
        lines: ['Current accounts'],
        items: [],
        actions: [{ id: 'add', label: 'Add account', knobs: [] }],
      },
      {
        id: 'cache',
        slot: 'cache',
        title: 'Cache',
        lines: ['Not available on OpenCode 2 yet.'],
        items: [],
        actions: [],
      },
    ],
  },
}

test('OpenCode 2 native menu cancel and back never apply', async () => {
  let step = 0
  let applies = 0
  const dialog = {
    async select(input: { options: Array<{ value: unknown }> }) {
      step++
      if (step === 1) return 'accounts'
      if (step === 2) return input.options.at(-1)?.value
      return undefined
    },
  } as unknown as Plugin.Context['ui']['dialog']
  await openReadOnlyDialog(dialog, payload, async () => {
    applies++
    throw new Error('must not apply')
  })
  expect(step).toBe(3)
  expect(applies).toBe(0)
})

test('OpenCode 2 native menu shows unavailable text and apply errors', async () => {
  let step = 0
  let applies = 0
  const alerts: string[] = []
  const dialog = {
    async select(input: { options: Array<{ value: unknown }> }) {
      step++
      if (step === 1) return 'cache'
      if (step === 2) return 'accounts'
      if (step === 3) return input.options[0]?.value
      return undefined
    },
    async alert(input: { message: string }) {
      alerts.push(input.message)
    },
  } as unknown as Plugin.Context['ui']['dialog']
  await openReadOnlyDialog(dialog, payload, async () => {
    applies++
    throw new Error('Exact apply error')
  })
  expect(applies).toBe(1)
  expect(alerts).toEqual([
    'Not available on OpenCode 2 yet.',
    'Exact apply error',
  ])
})
