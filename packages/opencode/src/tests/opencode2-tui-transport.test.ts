import { expect, test } from 'bun:test'
import type { Plugin } from '@opencode/plugin/tui'
import type { OpenDialogPayload } from '../rpc/protocol'
import { setupTui } from '../tui/v2'
import { openControlDialog } from '../tui/v2-dialog'

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
  await openControlDialog(dialog, payload, async () => {
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
  await openControlDialog(dialog, payload, async () => {
    applies++
    throw new Error('Exact apply error')
  })
  expect(applies).toBe(1)
  expect(alerts).toEqual([
    'Not available on OpenCode 2 yet.',
    'Exact apply error',
  ])
})

for (const cancel of [false, true]) {
  test(`OpenCode 2 native menu collects typed knobs and ${cancel ? 'cancels' : 'confirms'} removal`, async () => {
    const menu = structuredClone(payload)
    menu.menu.sections[0]!.actions = [
      {
        id: 'remove',
        label: 'Remove',
        confirm: { message: 'Delete credential?', irreversible: true },
        knobs: [
          { kind: 'text', id: 'label', label: 'Label', value: 'old' },
          { kind: 'number', id: 'primary', label: 'Floor', value: 20 },
          { kind: 'toggle', id: 'headless', label: 'Headless', value: false },
          {
            kind: 'choice',
            id: 'mode',
            label: 'Mode',
            choices: [{ value: 'ordered', label: 'Ordered' }],
            value: 'ordered',
          },
        ],
      },
    ]
    let step = 0
    const prompts: string[] = []
    const confirmations: string[] = []
    const requests: unknown[] = []
    const dialog = {
      async select(input: { options: Array<{ value: unknown }> }) {
        step++
        if (step === 1) return 'accounts'
        if (step === 2) return input.options[0]!.value
        if (step === 3) return true
        if (step === 4) return 'ordered'
        return undefined
      },
      async prompt(input: { title: string; value?: string }) {
        prompts.push(`${input.title}: ${input.value}`)
        return input.title === 'Label' ? 'Work' : '35'
      },
      async confirm(input: { message: string }) {
        confirmations.push(input.message)
        return !cancel
      },
      async alert() {},
    } as unknown as Plugin.Context['ui']['dialog']
    await openControlDialog(dialog, menu, async (request) => {
      requests.push(request)
      return { ...menu, ok: true, text: 'Done' }
    })
    expect(prompts).toEqual(['Label: old', 'Floor: 20'])
    expect(confirmations).toEqual(['Delete credential?'])
    expect(requests).toEqual(
      cancel
        ? []
        : [
            {
              command: 'openai',
              sectionId: 'accounts',
              actionId: 'remove',
              values: {
                label: 'Work',
                primary: 35,
                headless: true,
                mode: 'ordered',
              },
              confirmed: true,
            },
          ],
    )
  })
}

test('OpenCode 2 native menu cancels a knob without applying', async () => {
  const menu = structuredClone(payload)
  menu.menu.sections[0]!.actions[0]!.knobs = [
    { kind: 'text', id: 'label', label: 'Label' },
  ]
  let step = 0
  let applies = 0
  const dialog = {
    async select(input: { options: Array<{ value: unknown }> }) {
      if (++step === 1) return 'accounts'
      if (step === 2) return input.options[0]!.value
      return undefined
    },
    async prompt() {
      return undefined
    },
  } as unknown as Plugin.Context['ui']['dialog']
  await openControlDialog(dialog, menu, async () => {
    applies++
    throw new Error('must not apply')
  })
  expect(applies).toBe(0)
})
